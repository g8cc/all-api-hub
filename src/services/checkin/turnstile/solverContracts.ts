/**
 * Contracts for the optional third-party Turnstile solving service.
 *
 * The service only ever supplies a Turnstile token. It never touches a picture
 * captcha, a slider or any other verification layer, so sites that chain a
 * second challenge keep using the manual path.
 */

/** How to reach a solver deployment. */
export interface TurnstileSolverTransport {
  endpoint: string
  apiKey: string
  /** Total budget for one solve request, in milliseconds. */
  timeoutMs: number
}

export const TURNSTILE_SOLVER_FAILURE_CODES = {
  /** No Turnstile site key could be read from the page. */
  MissingSitekey: "missing_sitekey",
  /** The configured endpoint or key is unusable. */
  NotConfigured: "not_configured",
  /** The request failed before a response could be read. */
  Network: "network_error",
  /** The solver service reported a rejection. */
  Rejected: "rejected",
  /** The service answered, but the body was not a usable token payload. */
  InvalidResponse: "invalid_response",
  /** The solve budget ran out. */
  Timeout: "timeout",
} as const

export type TurnstileSolverFailureCode =
  (typeof TURNSTILE_SOLVER_FAILURE_CODES)[keyof typeof TURNSTILE_SOLVER_FAILURE_CODES]

export type TurnstileSolverOutcome =
  | {
      ok: true
      token: string
      elapsedMs: number
      /** Reported by the service when it counts its own widget attempts. */
      attempts: number | null
    }
  | {
      ok: false
      code: TurnstileSolverFailureCode
      /** Safe to log: the service message with no key and no token. */
      message: string
      elapsedMs: number
    }

/** A site key is an opaque Cloudflare string; anything else is page noise. */
const SITEKEY_PATTERN = /^[A-Za-z0-9_-]{10,64}$/

/** Accepts only a well-formed site key, so page junk is never sent to the service. */
export function normalizeTurnstileSitekey(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return SITEKEY_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * The token Cloudflare hands out for its own always-pass test sitekey
 * (`1x00000000000000000000AA`). It is shorter than any production token, so the
 * length floor below would otherwise reject a solve that really succeeded —
 * which is exactly the fixture used to verify this integration end to end.
 */
export const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA"
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"

/**
 * Normalizes an optional widget parameter (`action` / `cdata`).
 *
 * Sites bind a token to a task label, and the service validates the same shape,
 * so a value that does not fit is dropped rather than sent: a rejected request
 * costs credit and gains nothing over solving without the parameter.
 */
export function normalizeTurnstileWidgetParam(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null
}

/**
 * Validates a token before it is replayed to a site.
 *
 * A real Turnstile token is long and made of URL-safe characters; anything else
 * is a malformed or hostile reply, and sending it on would only add a second
 * failure to explain. Cloudflare's documented dummy token is accepted so a test
 * sitekey can prove the whole path end to end.
 */
export function normalizeTurnstileToken(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed === TURNSTILE_TEST_TOKEN) return trimmed
  if (trimmed.length < 40 || trimmed.length > 8_000) return null
  return /^[A-Za-z0-9_~!@#$%^&*()+=/\\-]+$/.test(trimmed) ? trimmed : null
}

/** Removes the credential from any text that may reach a log line. */
export function redactTurnstileSolverSecret(
  value: string,
  transport: TurnstileSolverTransport,
): string {
  const key = transport.apiKey.trim()
  if (!key) return value
  return value.split(key).join("***")
}
