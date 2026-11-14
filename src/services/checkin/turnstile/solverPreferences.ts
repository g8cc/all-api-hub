import {
  DEFAULT_TURNSTILE_SOLVER_MODE,
  TURNSTILE_SOLVER_DEFAULT_API_KEY,
  TURNSTILE_SOLVER_DEFAULT_ENDPOINT,
  TURNSTILE_SOLVER_DEFAULT_TIMEOUT_MS,
  TURNSTILE_SOLVER_MODES,
  type TurnstileSolverMode,
} from "./solverConstants"

export type { TurnstileSolverMode } from "./solverConstants"

/** Persisted configuration for the optional Turnstile solving service. */
export interface TurnstileSolverPreferences {
  /**
   * Whether to use the service at all.
   *
   * Explicit. A profile stored before this feature existed is filled from the
   * shipped defaults by the normalizer, so this only ever records a real choice
   * and never re-enables a service the user switched off.
   */
  enabled: boolean
  /** Solver gateway base URL. */
  endpoint: string
  /** Bearer credential. Empty disables the service regardless of `enabled`. */
  apiKey: string
  /** Whether the service runs before or after the page's own attempt. */
  mode: TurnstileSolverMode
  /** Budget for one solve request. */
  timeoutMs: number
}

/**
 * Defaults as shipped.
 *
 * `enabled` follows the bundled credential: a build that carries a key is meant
 * to use it, and emptying the key is the switch that turns the service off.
 */
export const DEFAULT_TURNSTILE_SOLVER_PREFERENCES: TurnstileSolverPreferences =
  {
    enabled: TURNSTILE_SOLVER_DEFAULT_API_KEY.trim().length > 0,
    endpoint: TURNSTILE_SOLVER_DEFAULT_ENDPOINT,
    apiKey: TURNSTILE_SOLVER_DEFAULT_API_KEY,
    mode: DEFAULT_TURNSTILE_SOLVER_MODE,
    timeoutMs: TURNSTILE_SOLVER_DEFAULT_TIMEOUT_MS,
  }

const TURNSTILE_SOLVER_TIMEOUT_LIMITS = { min: 5_000, max: 120_000 }

/** Accepts only a usable solver mode value. */
function isTurnstileSolverMode(value: unknown): value is TurnstileSolverMode {
  return Object.values(TURNSTILE_SOLVER_MODES).includes(
    value as TurnstileSolverMode,
  )
}

/**
 * Rebuilds solver settings from persisted data.
 *
 * Missing fields fall back to the shipped defaults, so an existing profile keeps
 * working after this feature is added; a stored empty key means the user turned
 * the service off and is not refilled from the default credential.
 */
export function normalizeTurnstileSolverPreferences(
  value: unknown,
): TurnstileSolverPreferences {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}

  const endpoint =
    typeof source.endpoint === "string" &&
    /^https?:\/\/.+/i.test(source.endpoint.trim())
      ? source.endpoint.trim()
      : TURNSTILE_SOLVER_DEFAULT_ENDPOINT

  const timeout =
    typeof source.timeoutMs === "number" && Number.isFinite(source.timeoutMs)
      ? Math.min(
          TURNSTILE_SOLVER_TIMEOUT_LIMITS.max,
          Math.max(TURNSTILE_SOLVER_TIMEOUT_LIMITS.min, source.timeoutMs),
        )
      : TURNSTILE_SOLVER_DEFAULT_TIMEOUT_MS

  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_TURNSTILE_SOLVER_PREFERENCES.enabled,
    endpoint,
    apiKey:
      typeof source.apiKey === "string"
        ? source.apiKey.trim()
        : TURNSTILE_SOLVER_DEFAULT_API_KEY,
    mode: isTurnstileSolverMode(source.mode)
      ? source.mode
      : DEFAULT_TURNSTILE_SOLVER_MODE,
    timeoutMs: Math.round(timeout),
  }
}
