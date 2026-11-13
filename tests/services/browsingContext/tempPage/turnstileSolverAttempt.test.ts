import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  attemptTurnstileSolver,
  isTurnstileSolverUsable,
  shouldUseTurnstileSolver,
} from "~/services/browsingContext/tempPage/turnstileSolverAttempt"
import { TURNSTILE_SOLVER_MODES } from "~/services/checkin/turnstile/solverConstants"
import { sendTabMessageWithRetry } from "~/utils/browser/runtimeMessages"

vi.mock("~/utils/browser/runtimeMessages", () => ({
  sendTabMessageWithRetry: vi.fn(),
}))

vi.mock("~/services/browsingContext/tempPage/diagnostics", () => ({
  logTempWindow: vi.fn(),
}))

const TOKEN = `${"B".repeat(200)}-token`

const preferences = {
  enabled: true,
  endpoint: "https://solver.test",
  apiKey: "sk-test",
  mode: TURNSTILE_SOLVER_MODES.ApiBeforePage,
  timeoutMs: 20_000,
}

describe("Turnstile solver attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the service token when the page exposes a site key", async () => {
    vi.mocked(sendTabMessageWithRetry).mockResolvedValue({
      success: true,
      sitekey: "0x4AAAAAAA-page-key",
    })
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ token: TOKEN, attempts: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchImpl)

    const attempt = await attemptTurnstileSolver({
      tabId: 7,
      pageUrl: "https://site.test/console/personal",
      preferences,
    })

    expect(attempt.sitekeyFound).toBe(true)
    expect(attempt.token).toBe(TOKEN)
    expect(attempt.meta).toMatchObject({ attempted: true, ok: true })
    expect(sendTabMessageWithRetry).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ action: "readTurnstileSitekey" }),
    )
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as any)[1].body))
    expect(body).toMatchObject({
      url: "https://site.test/console/personal",
      sitekey: "0x4AAAAAAA-page-key",
    })
    vi.unstubAllGlobals()
  })

  it("forwards the parameters the page binds the token to", async () => {
    vi.mocked(sendTabMessageWithRetry).mockResolvedValue({
      success: true,
      sitekey: "0x4AAAAAAA-page-key",
      action: "daily_checkin",
      cdata: "account-7",
    })
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ token: TOKEN }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchImpl)

    await attemptTurnstileSolver({
      tabId: 7,
      pageUrl: "https://site.test/",
      preferences,
    })

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({
      action: "daily_checkin",
      cdata: "account-7",
    })
    vi.unstubAllGlobals()
  })

  it("asks nothing of the service when the page has no site key", async () => {
    vi.mocked(sendTabMessageWithRetry).mockResolvedValue({
      success: true,
      sitekey: null,
    })
    const fetchImpl = vi.fn()
    vi.stubGlobal("fetch", fetchImpl)

    const attempt = await attemptTurnstileSolver({
      tabId: 7,
      pageUrl: "https://site.test/",
      preferences,
    })

    expect(attempt.token).toBeNull()
    expect(attempt.sitekeyFound).toBe(false)
    expect(attempt.meta.attempted).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("does not read the page at all when the feature is off", async () => {
    const attempt = await attemptTurnstileSolver({
      tabId: 7,
      pageUrl: "https://site.test/",
      preferences: { ...preferences, enabled: false },
    })

    expect(attempt).toEqual({
      token: null,
      meta: { attempted: false, ok: false },
      sitekeyFound: false,
    })
    expect(sendTabMessageWithRetry).not.toHaveBeenCalled()
  })

  it("reports a solve failure instead of throwing", async () => {
    vi.mocked(sendTabMessageWithRetry).mockResolvedValue({
      success: true,
      sitekey: "0x4AAAAAAA-page-key",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "error", message: "排队中" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )

    const attempt = await attemptTurnstileSolver({
      tabId: 7,
      pageUrl: "https://site.test/",
      preferences,
    })

    expect(attempt.token).toBeNull()
    expect(attempt.meta.attempted).toBe(true)
    expect(attempt.meta.ok).toBe(false)
    expect(attempt.meta.code).toBe("rejected")
    vi.unstubAllGlobals()
  })

  it("keeps ordering decisions with the caller", () => {
    expect(isTurnstileSolverUsable(preferences)).toBe(true)
    expect(isTurnstileSolverUsable({ ...preferences, apiKey: "" })).toBe(false)
    expect(
      shouldUseTurnstileSolver({
        preferences,
        mode: TURNSTILE_SOLVER_MODES.ApiBeforePage,
      }),
    ).toBe(true)
    expect(
      shouldUseTurnstileSolver({
        preferences,
        mode: TURNSTILE_SOLVER_MODES.PageBeforeApi,
      }),
    ).toBe(false)
  })
})
