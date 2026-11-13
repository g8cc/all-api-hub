import { beforeEach, describe, expect, it, vi } from "vitest"

import { solveTurnstileWithService } from "~/services/checkin/turnstile/solver"
import {
  TURNSTILE_SOLVER_FAILURE_CODES,
  TURNSTILE_TEST_SITEKEY,
  TURNSTILE_TEST_TOKEN,
} from "~/services/checkin/turnstile/solverContracts"

const API_KEY = "sk-test-secret-value"
const TOKEN = `${"A".repeat(200)}_-!~token`

const transport = {
  endpoint: "https://solver.test",
  apiKey: API_KEY,
  timeoutMs: 20_000,
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

describe("Turnstile solver client", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("sends the page URL and site key with a bearer credential", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: TOKEN, attempts: 1 }),
    )

    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/console/personal",
        sitekey: "0x4AAAAAAA-site-key",
        transport,
      },
      fetchImpl as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.token).toBe(TOKEN)
    expect(outcome.attempts).toBe(1)

    const calls = fetchImpl.mock.calls as unknown as Array<
      [string, RequestInit & { headers: Record<string, string> }]
    >
    const [url, init] = calls[0]!
    expect(url).toBe("https://solver.test/solve")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(init.credentials).toBe("omit")
    expect(JSON.parse(String(init.body))).toEqual({
      url: "https://site.test/console/personal",
      sitekey: "0x4AAAAAAA-site-key",
      timeout: 20,
    })
  })

  it("accepts a token nested in a solution object", async () => {
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        transport,
      },
      vi.fn(async () =>
        jsonResponse({ solution: { token: TOKEN } }),
      ) as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.token).toBe(TOKEN)
  })

  it("passes a well-formed action and drops a malformed one", async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(String(init?.body))
      return jsonResponse({ token: TOKEN })
    })

    await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        action: "daily_checkin",
        transport,
      },
      fetchImpl as unknown as typeof fetch,
    )
    await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        action: "bad action; drop",
        transport,
      },
      fetchImpl as unknown as typeof fetch,
    )

    expect(JSON.parse(seen[0]!).action).toBe("daily_checkin")
    expect(JSON.parse(seen[1]!).action).toBeUndefined()
  })

  it("reports a service rejection without leaking the credential", async () => {
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        transport,
      },
      vi.fn(async () =>
        jsonResponse({
          status: "error",
          code: "turnstile_error",
          message: `Turnstile 返回错误 400020 key=${API_KEY}`,
        }),
      ) as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(TURNSTILE_SOLVER_FAILURE_CODES.Rejected)
    expect(outcome.message).not.toContain(API_KEY)
    expect(outcome.message).toContain("***")
  })

  it("treats an unauthorized HTTP answer as a rejection", async () => {
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        transport: { ...transport, apiKey: "sk-wrong" },
      },
      vi.fn(
        async () => new Response("unauthorized", { status: 401 }),
      ) as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(TURNSTILE_SOLVER_FAILURE_CODES.Rejected)
    expect(outcome.message).toContain("401")
  })

  it("carries the parameters a deployment binds the token to", async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(String(init?.body))
      return jsonResponse({ token: TOKEN })
    })

    await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        action: "login",
        cdata: "checkin-2026-11-13",
        transport,
      },
      fetchImpl as unknown as typeof fetch,
    )
    // A value the service would reject is dropped instead of spending credit.
    await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        action:
          "bound to the session token abcdefghijklmnopqrstuvwxyz0123456789",
        cdata: "带中文",
        transport,
      },
      fetchImpl as unknown as typeof fetch,
    )

    expect(JSON.parse(seen[0]!)).toMatchObject({
      action: "login",
      cdata: "checkin-2026-11-13",
    })
    expect(JSON.parse(seen[1]!)).not.toHaveProperty("action")
    expect(JSON.parse(seen[1]!)).not.toHaveProperty("cdata")
  })

  it("accepts the token Cloudflare issues for its own test sitekey", async () => {
    // The always-pass fixture is the shortest legitimate answer the service can
    // return; a length floor tuned for production tokens must not reject it.
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://example.com/",
        sitekey: TURNSTILE_TEST_SITEKEY,
        transport,
      },
      vi.fn(async () =>
        jsonResponse({ token: TURNSTILE_TEST_TOKEN }),
      ) as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.token).toBe(TURNSTILE_TEST_TOKEN)
  })

  it("rejects a body that carries no usable token", async () => {
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        transport,
      },
      vi.fn(async () =>
        jsonResponse({ token: "short" }),
      ) as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(TURNSTILE_SOLVER_FAILURE_CODES.Rejected)
  })

  it("does not call the service when the page has no site key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: TOKEN }))
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: null,
        transport,
      },
      fetchImpl as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(TURNSTILE_SOLVER_FAILURE_CODES.MissingSitekey)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("does not call the service when it is not configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: TOKEN }))
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        transport: { ...transport, apiKey: "  " },
      },
      fetchImpl as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(TURNSTILE_SOLVER_FAILURE_CODES.NotConfigured)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reports a transport failure instead of throwing", async () => {
    const outcome = await solveTurnstileWithService(
      {
        pageUrl: "https://site.test/",
        sitekey: "0x4AAAAAAA-site-key",
        transport,
      },
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${API_KEY}`)
      }) as unknown as typeof fetch,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(TURNSTILE_SOLVER_FAILURE_CODES.Network)
    expect(outcome.message).not.toContain(API_KEY)
  })
})
