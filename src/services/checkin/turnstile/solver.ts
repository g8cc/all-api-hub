import { TURNSTILE_SOLVER_DEFAULT_TIMEOUT_MS } from "./solverConstants"
import {
  normalizeTurnstileSitekey,
  normalizeTurnstileToken,
  normalizeTurnstileWidgetParam,
  redactTurnstileSolverSecret,
  TURNSTILE_SOLVER_FAILURE_CODES,
  type TurnstileSolverOutcome,
  type TurnstileSolverTransport,
} from "./solverContracts"

/**
 * Client for a Turnstile solving service that speaks the documented
 * `POST /solve` contract: it renders the widget on the caller's page URL and
 * returns the token, so no browser window has to be shown to the user.
 */

/** Whether a usable solver is configured. */
function isTurnstileSolverConfigured(
  transport: Pick<TurnstileSolverTransport, "apiKey" | "endpoint">,
): boolean {
  return (
    typeof transport.endpoint === "string" &&
    /^https?:\/\//i.test(transport.endpoint.trim()) &&
    typeof transport.apiKey === "string" &&
    transport.apiKey.trim().length > 0
  )
}

/**
 * Builds the solve endpoint from a user-entered base URL.
 *
 * Trailing slashes are trimmed so a pasted `https://host/` and a pasted
 * `https://host` reach the same address.
 */
function solverUrl(endpoint: string): string {
  return `${endpoint.trim().replace(/\/+$/, "")}/solve`
}

/** Reads a token out of a solved response, tolerating wrapped payloads. */
function readToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const record = payload as Record<string, unknown>
  const direct = normalizeTurnstileToken(record.token)
  if (direct) return direct
  const solution = record.solution
  if (solution && typeof solution === "object") {
    return normalizeTurnstileToken((solution as Record<string, unknown>).token)
  }
  return null
}

/**
 * Extracts the human-readable reason from a solver reply.
 *
 * Providers disagree on the field name, so the first of message, error and
 * errorDescription wins and the fallback keeps failures describable anyway.
 */
function readMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback
  const record = payload as Record<string, unknown>
  for (const key of ["message", "error", "errorDescription"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return fallback
}

/**
 * Solves one Turnstile widget for `pageUrl`.
 *
 * Failures are returned, never thrown: a solver outage must not turn into a
 * check-in error, because the caller still has the page-wait and manual paths.
 */
export async function solveTurnstileWithService(
  params: {
    pageUrl: string
    sitekey: unknown
    action?: unknown
    cdata?: unknown
    transport: TurnstileSolverTransport
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileSolverOutcome> {
  const startedAt = Date.now()
  const { transport } = params
  const sitekey = normalizeTurnstileSitekey(params.sitekey)

  if (!sitekey) {
    return {
      ok: false,
      code: TURNSTILE_SOLVER_FAILURE_CODES.MissingSitekey,
      message: "Turnstile site key not found on the page",
      elapsedMs: Date.now() - startedAt,
    }
  }

  if (!isTurnstileSolverConfigured(transport)) {
    return {
      ok: false,
      code: TURNSTILE_SOLVER_FAILURE_CODES.NotConfigured,
      message: "Turnstile solver is not configured",
      elapsedMs: Date.now() - startedAt,
    }
  }

  const timeoutMs =
    typeof transport.timeoutMs === "number" &&
    Number.isFinite(transport.timeoutMs) &&
    transport.timeoutMs > 0
      ? transport.timeoutMs
      : TURNSTILE_SOLVER_DEFAULT_TIMEOUT_MS

  const body: Record<string, unknown> = {
    url: params.pageUrl,
    sitekey,
    timeout: Math.max(5, Math.round(timeoutMs / 1000)),
  }
  const action = normalizeTurnstileWidgetParam(params.action, 32)
  if (action) body.action = action
  const cdata = normalizeTurnstileWidgetParam(params.cdata, 255)
  if (cdata) body.cdata = cdata

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000)

  try {
    const response = await fetchImpl(solverUrl(transport.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${transport.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
    })

    const text = await response.text().catch(() => "")
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    if (!payload) {
      return {
        ok: false,
        code: response.ok
          ? TURNSTILE_SOLVER_FAILURE_CODES.InvalidResponse
          : TURNSTILE_SOLVER_FAILURE_CODES.Rejected,
        message: redactTurnstileSolverSecret(
          readMessage(
            payload,
            `HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
          ),
          transport,
        ),
        elapsedMs: Date.now() - startedAt,
      }
    }

    const token = readToken(payload)
    if (token && response.ok) {
      const attempts = (payload as Record<string, unknown>).attempts
      return {
        ok: true,
        token,
        elapsedMs: Date.now() - startedAt,
        attempts:
          typeof attempts === "number" && Number.isFinite(attempts)
            ? attempts
            : null,
      }
    }

    return {
      ok: false,
      code: TURNSTILE_SOLVER_FAILURE_CODES.Rejected,
      message: redactTurnstileSolverSecret(
        readMessage(payload, "Solver returned no token"),
        transport,
      ),
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      ok: false,
      code: aborted
        ? TURNSTILE_SOLVER_FAILURE_CODES.Timeout
        : TURNSTILE_SOLVER_FAILURE_CODES.Network,
      message: redactTurnstileSolverSecret(
        aborted
          ? "Solver request timed out"
          : error instanceof Error
            ? error.message
            : String(error),
        transport,
      ),
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}
