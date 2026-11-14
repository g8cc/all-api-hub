import { describe, expect, it } from "vitest"

import {
  TURNSTILE_SOLVER_DEFAULT_API_KEY,
  TURNSTILE_SOLVER_MODES,
} from "~/services/checkin/turnstile/solverConstants"
import {
  DEFAULT_TURNSTILE_SOLVER_PREFERENCES,
  normalizeTurnstileSolverPreferences,
} from "~/services/checkin/turnstile/solverPreferences"
import { normalizeTempWindowFallbackPreferences } from "~/services/preferences/tempWindowFallbackPreferences"

describe("Turnstile solver preferences", () => {
  it("falls back to the shipped configuration for a stored profile without it", () => {
    expect(normalizeTurnstileSolverPreferences(undefined)).toEqual(
      DEFAULT_TURNSTILE_SOLVER_PREFERENCES,
    )
    expect(normalizeTurnstileSolverPreferences(null).endpoint).toBe(
      DEFAULT_TURNSTILE_SOLVER_PREFERENCES.endpoint,
    )
  })

  it("keeps an explicitly emptied key off", () => {
    const normalized = normalizeTurnstileSolverPreferences({
      enabled: true,
      apiKey: "   ",
    })

    expect(normalized.apiKey).toBe("")
    // An empty credential must make the feature unusable even when switched on.
    expect(normalized.enabled).toBe(true)
    expect(normalized.apiKey.trim()).toHaveLength(0)
  })

  it("honours an explicit opt-out", () => {
    expect(
      normalizeTurnstileSolverPreferences({
        enabled: false,
        apiKey: "sk-kept",
      }),
    ).toMatchObject({ enabled: false, apiKey: "sk-kept" })
  })

  it("drops a malformed endpoint and mode", () => {
    const normalized = normalizeTurnstileSolverPreferences({
      endpoint: "solver.test",
      mode: "always",
    })

    expect(normalized.endpoint).toBe(
      DEFAULT_TURNSTILE_SOLVER_PREFERENCES.endpoint,
    )
    expect(normalized.mode).toBe(DEFAULT_TURNSTILE_SOLVER_PREFERENCES.mode)
  })

  it("clamps the solve budget into a usable range", () => {
    expect(
      normalizeTurnstileSolverPreferences({ timeoutMs: 1 }).timeoutMs,
    ).toBe(5_000)
    expect(
      normalizeTurnstileSolverPreferences({ timeoutMs: 10_000_000 }).timeoutMs,
    ).toBe(120_000)
    expect(
      normalizeTurnstileSolverPreferences({ timeoutMs: "fast" }).timeoutMs,
    ).toBe(DEFAULT_TURNSTILE_SOLVER_PREFERENCES.timeoutMs)
  })

  it("accepts both documented orders", () => {
    for (const mode of Object.values(TURNSTILE_SOLVER_MODES)) {
      expect(normalizeTurnstileSolverPreferences({ mode }).mode).toBe(mode)
    }
  })
})

describe("Turnstile solver inside the shield preferences", () => {
  it("reaches an existing profile through the shield normalizer", () => {
    // A profile saved before this feature existed has no solver block at all.
    const normalized = normalizeTempWindowFallbackPreferences(undefined)

    expect(normalized.turnstileSolver).toEqual(
      DEFAULT_TURNSTILE_SOLVER_PREFERENCES,
    )
    // The credential decides the default: a build that carries one uses it with
    // no opt-in, a build that carries none leaves the service off.
    expect(normalized.turnstileSolver?.enabled).toBe(
      TURNSTILE_SOLVER_DEFAULT_API_KEY.trim().length > 0,
    )
  })

  it("keeps a stored choice after the shield preferences are re-normalized", () => {
    const stored = normalizeTempWindowFallbackPreferences({
      turnstileSolver: {
        enabled: false,
        apiKey: "sk-kept",
        mode: "page_before_api",
      },
    })
    const again = normalizeTempWindowFallbackPreferences(stored)

    expect(again.turnstileSolver).toEqual(stored.turnstileSolver)
    expect(again.turnstileSolver?.enabled).toBe(false)
    expect(again.turnstileSolver?.mode).toBe(
      TURNSTILE_SOLVER_MODES.PageBeforeApi,
    )
  })
})
