import { RuntimeActionIds } from "~/constants/runtimeActions"
import { solveTurnstileWithService } from "~/services/checkin/turnstile/solver"
import type { TurnstileSolverMode } from "~/services/checkin/turnstile/solverConstants"
import { TURNSTILE_SOLVER_FAILURE_CODES } from "~/services/checkin/turnstile/solverContracts"
import type { TurnstileSolverPreferences } from "~/services/checkin/turnstile/solverPreferences"
import type { TempWindowTurnstileSolverMeta } from "~/types/tempWindowFetch"
import { sendTabMessageWithRetry } from "~/utils/browser/runtimeMessages"
import { getErrorMessage } from "~/utils/core/error"

import { logTempWindow } from "./diagnostics"

/**
 * Optional third-party Turnstile solving for the temporary context.
 *
 * Scope is deliberately narrow: the service answers with a Turnstile token and
 * nothing else. A site that also wants a picture captcha, a slider or a second
 * verification layer still reaches the existing manual path, because this code
 * never tries to satisfy those.
 */

export type TurnstileSolverAttempt = {
  token: string | null
  meta: TempWindowTurnstileSolverMeta
  /** The page carried a Turnstile widget the service could be asked about. */
  sitekeyFound: boolean
}

const NOT_ATTEMPTED: TurnstileSolverAttempt = {
  token: null,
  meta: { attempted: false, ok: false },
  sitekeyFound: false,
}

/** Whether a usable service is switched on, whatever the configured order. */
export function isTurnstileSolverUsable(
  preferences: TurnstileSolverPreferences,
): boolean {
  return (
    preferences.enabled &&
    preferences.apiKey.trim().length > 0 &&
    /^https?:\/\//i.test(preferences.endpoint.trim())
  )
}

/** Whether this run should consult the service, given where it sits in the order. */
export function shouldUseTurnstileSolver(params: {
  preferences: TurnstileSolverPreferences
  mode: TurnstileSolverMode
}): boolean {
  return (
    isTurnstileSolverUsable(params.preferences) &&
    params.preferences.mode === params.mode
  )
}

/** Reads the public site key from the temporary tab, without touching the widget. */
/** The widget the page renders: its key plus any parameter the token is bound to. */
interface TurnstileWidgetParams {
  sitekey: string
  action: string | null
  cdata: string | null
}

/**
 * Reads the widget parameters from the page without clicking anything.
 *
 * The content script reports only what the markup already holds, so asking it
 * never spends the site's single check-in attempt of the day.
 */
async function readTabTurnstileWidget(
  tabId: number,
): Promise<TurnstileWidgetParams | null> {
  try {
    const response = await sendTabMessageWithRetry(tabId, {
      action: RuntimeActionIds.ContentReadTurnstileSitekey,
    })
    if (response?.success && typeof response?.sitekey === "string") {
      return {
        sitekey: response.sitekey,
        action: typeof response?.action === "string" ? response.action : null,
        cdata: typeof response?.cdata === "string" ? response.cdata : null,
      }
    }
    return null
  } catch (error) {
    logTempWindow("turnstileSolverSitekeyReadFailed", {
      tabId,
      error: getErrorMessage(error),
    })
    return null
  }
}

/**
 * Asks the service for one token, then returns it or a safe diagnostic.
 *
 * The token itself is never logged, and a failure is reported as an outcome
 * rather than an error so the caller can fall through to the page wait.
 */
export async function attemptTurnstileSolver(params: {
  tabId: number
  pageUrl: string
  preferences: TurnstileSolverPreferences
}): Promise<TurnstileSolverAttempt> {
  const { preferences } = params

  if (!isTurnstileSolverUsable(preferences)) {
    return NOT_ATTEMPTED
  }
  const widget = await readTabTurnstileWidget(params.tabId)
  if (!widget) {
    logTempWindow("turnstileSolverSkippedNoSitekey", {
      pageUrl: params.pageUrl,
    })
    return {
      token: null,
      meta: {
        attempted: false,
        ok: false,
        code: TURNSTILE_SOLVER_FAILURE_CODES.MissingSitekey,
      },
      sitekeyFound: false,
    }
  }

  const outcome = await solveTurnstileWithService({
    pageUrl: params.pageUrl,
    sitekey: widget.sitekey,
    action: widget.action,
    cdata: widget.cdata,
    transport: {
      endpoint: preferences.endpoint,
      apiKey: preferences.apiKey,
      timeoutMs: preferences.timeoutMs,
    },
  })

  if (outcome.ok) {
    logTempWindow("turnstileSolverTokenObtained", {
      elapsedMs: outcome.elapsedMs,
      attempts: outcome.attempts,
    })
    return {
      token: outcome.token,
      meta: { attempted: true, ok: true, elapsedMs: outcome.elapsedMs },
      sitekeyFound: true,
    }
  }

  logTempWindow("turnstileSolverFailed", {
    code: outcome.code,
    message: outcome.message,
    elapsedMs: outcome.elapsedMs,
  })
  return {
    token: null,
    meta: {
      attempted: true,
      ok: false,
      code: outcome.code,
      elapsedMs: outcome.elapsedMs,
    },
    sitekeyFound: true,
  }
}
