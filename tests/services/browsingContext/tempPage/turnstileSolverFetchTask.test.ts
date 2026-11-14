import { beforeEach, describe, expect, it, vi } from "vitest"

import { RuntimeActionIds } from "~/constants/runtimeActions"
import { executeTempWindowTurnstileFetch } from "~/services/browsingContext/tempPage/fetchTasks"
import { TURNSTILE_SOLVER_MODES } from "~/services/checkin/turnstile/solverConstants"

const {
  acquireMock,
  prepareFetchOptionsMock,
  getPreferencesMock,
  runtimeMessageMock,
} = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  prepareFetchOptionsMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  runtimeMessageMock: vi.fn(),
}))

vi.mock("~/utils/browser/runtimeMessages", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/utils/browser/runtimeMessages")>()
  return { ...actual, sendTabMessageWithRetry: runtimeMessageMock }
})

vi.mock("~/services/browsingContext/tempPage/runtime", () => ({
  tempWindowBackgroundRuntime: {
    acquire: acquireMock,
    release: vi.fn(),
    prepareFetchOptions: prepareFetchOptionsMock,
  },
}))

vi.mock("~/services/preferences/userPreferences", () => ({
  userPreferences: { getPreferences: getPreferencesMock },
}))

vi.mock(
  "~/services/browsingContext/tempPage/failures",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("~/services/browsingContext/tempPage/failures")
      >()
    return {
      ...actual,
      trackTempWindowFetchCompleted: vi.fn(),
      reportAuthorizedTempContextOutcome: vi.fn(),
    }
  },
)

const TAB_ID = 42
const SOLVER_TOKEN = `${"C".repeat(220)}-solved-token`
const SITEKEY = "0x4AAAAAAA-page-key"

const baseRequest = {
  originUrl: "https://site.test",
  pageUrl: "https://site.test/console/personal",
  fetchUrl: "https://site.test/api/user/checkin",
  fetchOptions: { method: "POST", body: "{}", headers: {} },
  responseType: "json",
  requestId: "req-turnstile-solver",
  authType: "accessToken",
  turnstileTimeoutMs: 12_000,
  turnstilePreTrigger: { kind: "none" },
} as const

/** Records what the run asked of the page and of the service, in order. */
const callOrder: string[] = []

function configureSolver(solver: Record<string, unknown>) {
  getPreferencesMock.mockResolvedValue({
    tempWindowFallback: { turnstileSolver: solver },
  })
}

function solverEnabled(mode: string) {
  configureSolver({
    enabled: true,
    endpoint: "https://solver.test",
    apiKey: "sk-test",
    mode,
    timeoutMs: 20_000,
  })
}

async function run(sendResponse = vi.fn()): Promise<Record<string, any>> {
  await executeTempWindowTurnstileFetch(
    baseRequest as never,
    false,
    sendResponse,
    undefined,
  )
  return sendResponse.mock.calls.at(-1)![0] as Record<string, any>
}

/** The page never produces a token, so only the service can complete the run. */
function pageYieldsNoToken() {
  runtimeMessageMock.mockImplementation(
    async (_tabId: number, message: any) => {
      if (message.action === RuntimeActionIds.ContentReadTurnstileSitekey) {
        callOrder.push("sitekey")
        return { success: true, sitekey: SITEKEY }
      }
      if (message.action === RuntimeActionIds.ContentWaitForTurnstileToken) {
        callOrder.push("page-wait")
        return {
          success: true,
          status: "timeout",
          token: null,
          detection: { hasTurnstile: true },
        }
      }
      callOrder.push("replay")
      return { success: true, status: 200, data: { ok: true } }
    },
  )
}

describe("Turnstile-assisted temp fetch with a solving service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    acquireMock.mockResolvedValue({
      tabId: TAB_ID,
      navigate: vi.fn(async () => undefined),
    })
    prepareFetchOptionsMock.mockImplementation(async (params: any) => ({
      ruleIds: [],
      effectiveFetchOptions: params.rawOptions,
    }))
  })

  it("asks the service before showing the page any wait", async () => {
    solverEnabled(TURNSTILE_SOLVER_MODES.ApiBeforePage)
    pageYieldsNoToken()
    const fetchMock = vi.fn(async () => {
      callOrder.push("solver")
      return new Response(
        JSON.stringify({ token: SOLVER_TOKEN, attempts: 1 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const payload = await run()

    // No page wait at all: the token arrived first, so nothing was shown.
    expect(callOrder).toEqual(["sitekey", "solver", "replay"])

    const solverCalls = fetchMock.mock.calls as unknown as [
      string,
      RequestInit,
    ][]
    const body = JSON.parse(String(solverCalls[0]![1].body))
    expect(body).toMatchObject({ url: baseRequest.pageUrl, sitekey: SITEKEY })

    const replay = runtimeMessageMock.mock.calls.find(
      (call: any[]) =>
        call[1]?.action === RuntimeActionIds.ContentPerformTempWindowFetch,
    ) as any[]
    expect(replay[1].fetchUrl).toContain(`turnstile=${SOLVER_TOKEN}`)
    expect(payload.turnstile).toMatchObject({
      status: "token_obtained",
      hasTurnstile: true,
      solver: { attempted: true, ok: true },
    })
    vi.unstubAllGlobals()
  })

  it("falls back to the page wait when the service cannot help", async () => {
    solverEnabled(TURNSTILE_SOLVER_MODES.ApiBeforePage)
    pageYieldsNoToken()
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "error",
            message: "Turnstile 返回错误 400020",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const payload = await run()

    // The service answered first and failed; the page wait follows, and the
    // service is not asked a second time.
    expect(callOrder).toEqual(["sitekey", "page-wait"])
    expect(payload.success).toBe(false)
    expect(payload.turnstile.status).toBe("timeout")
    expect(payload.turnstile.solver).toMatchObject({
      attempted: true,
      ok: false,
      code: "rejected",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it("lets the page try first when the order is page_before_api", async () => {
    solverEnabled(TURNSTILE_SOLVER_MODES.PageBeforeApi)
    pageYieldsNoToken()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callOrder.push("solver")
        return new Response(JSON.stringify({ token: SOLVER_TOKEN }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }),
    )

    const payload = await run()

    expect(callOrder).toEqual(["page-wait", "sitekey", "solver", "replay"])
    expect(payload.turnstile).toMatchObject({
      status: "token_obtained",
      solver: { attempted: true, ok: true },
    })
    vi.unstubAllGlobals()
  })

  it("never reads the page for a solver when the service is off", async () => {
    configureSolver({
      enabled: false,
      endpoint: "https://solver.test",
      apiKey: "sk-test",
      mode: TURNSTILE_SOLVER_MODES.ApiBeforePage,
      timeoutMs: 20_000,
    })
    pageYieldsNoToken()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const payload = await run()

    expect(callOrder).toEqual(["page-wait"])
    expect(fetchMock).not.toHaveBeenCalled()
    // Nothing is recorded when the service is switched off: the run never
    // involved it, so the result keeps the shape it had before this feature.
    expect(payload.turnstile.solver).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it("keeps using the page token when the page produces one itself", async () => {
    solverEnabled(TURNSTILE_SOLVER_MODES.PageBeforeApi)
    runtimeMessageMock.mockImplementation(
      async (_tabId: number, message: any) => {
        if (message.action === RuntimeActionIds.ContentWaitForTurnstileToken) {
          callOrder.push("page-wait")
          return {
            success: true,
            status: "token_obtained",
            token: `${"P".repeat(200)}-page-token`,
            detection: { hasTurnstile: true },
          }
        }
        if (message.action === RuntimeActionIds.ContentReadTurnstileSitekey) {
          callOrder.push("sitekey")
          return { success: true, sitekey: SITEKEY }
        }
        callOrder.push("replay")
        return { success: true, status: 200, data: { ok: true } }
      },
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const payload = await run()

    // A widget that passes for free must never cost a service request.
    expect(callOrder).toEqual(["page-wait", "replay"])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(payload.turnstile.status).toBe("token_obtained")
    vi.unstubAllGlobals()
  })
})
