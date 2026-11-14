import { RuntimeActionIds } from "~/constants/runtimeActions"
import {
  TURNSTILE_AUTO_ASSIST_MS,
  TURNSTILE_MANUAL_WAIT_MS,
  TURNSTILE_PAGE_API_POLL_MS,
} from "~/constants/turnstile"
import {
  triggerCheckinPageAction,
  waitForCheckinPageActionTarget,
  waitForTurnstileToken,
  type TurnstileUserAssist,
} from "~/entrypoints/content/messageHandlers/utils/turnstileGuard"
import {
  capturePageVerificationWidgets,
  waitForPageVerification,
} from "~/services/checkin/pageVerification"
import { extractTurnstileWidgetParams } from "~/services/checkin/turnstile/sitekey"
import {
  TURNSTILE_SOLVER_SITEKEY_POLL_MS,
  TURNSTILE_SOLVER_SITEKEY_WAIT_MS,
} from "~/services/checkin/turnstile/solverConstants"
import type {
  CheckinPageActionTriggerResult,
  TurnstilePreTrigger,
  TurnstileTokenWaitResult,
} from "~/types/turnstile"
import { sendRuntimeMessage } from "~/utils/browser/runtimeMessages"
import { getErrorMessage } from "~/utils/core/error"
import { createLogger } from "~/utils/core/logger"

interface WaitForTurnstileTokenRequest {
  requestId?: string
  timeoutMs?: number
  preTrigger?: TurnstilePreTrigger
}

interface WaitForTurnstileTokenSuccessResponse
  extends TurnstileTokenWaitResult {
  success: true
}

interface WaitForTurnstileTokenErrorResponse {
  success: false
  error: string
}

type WaitForTurnstileTokenResponse =
  | WaitForTurnstileTokenSuccessResponse
  | WaitForTurnstileTokenErrorResponse

interface TriggerCheckinPageActionRequest {
  requestId?: string
  trigger?: TurnstilePreTrigger
}

interface TriggerCheckinPageActionSuccessResponse
  extends CheckinPageActionTriggerResult {
  success: true
}

interface TriggerCheckinPageActionErrorResponse {
  success: false
  error: string
}

type TriggerCheckinPageActionResponse =
  | TriggerCheckinPageActionSuccessResponse
  | TriggerCheckinPageActionErrorResponse

/**
 * Builds the in-page assist hooks for a Turnstile wait.
 * The page API read stays in the background so only an owned temp tab is probed.
 */
function createTurnstileUserAssist(requestId?: string): TurnstileUserAssist {
  return {
    autoAttemptMs: TURNSTILE_AUTO_ASSIST_MS,
    manualTimeoutMs: TURNSTILE_MANUAL_WAIT_MS,
    pageTokenIntervalMs: TURNSTILE_PAGE_API_POLL_MS,
    requestAssist: async () => {
      let presented: boolean
      try {
        const response = await sendRuntimeMessage<{ presented?: boolean }>({
          action: RuntimeActionIds.TurnstileRequestUserAssist,
          requestId,
        })
        presented = response?.presented === true
      } catch {
        presented = false
      }
      if (!presented) return false
      // Loaded lazily so content-script UI setup is not pulled into node tests.
      const { showTurnstileManualAssistToast } = await import(
        "~/entrypoints/content/shieldBypassAssist/utils/shieldBypassToasts"
      )
      await showTurnstileManualAssistToast()
      return true
    },
    readPageToken: async ({ allowExecute }) => {
      try {
        const response = await sendRuntimeMessage<{
          success?: boolean
          token?: unknown
        }>({
          action: RuntimeActionIds.TurnstileReadPageApi,
          allowExecute,
        })
        if (!response?.success || typeof response.token !== "string")
          return null
        const token = response.token.trim()
        return token || null
      } catch {
        return null
      }
    },
  }
}

/**
 * Unified logger scoped to Turnstile token waits in the content script.
 */
const logger = createLogger("TurnstileGuardHandler")

/**
 * Handle Turnstile token wait requests.
 *
 * This handler is designed for temporary contexts: it performs a bounded wait
 * for a `cf-turnstile-response` token without attempting to solve Turnstile.
 */
export function handleWaitForTurnstileToken(
  request: WaitForTurnstileTokenRequest,
  sendResponse: (res: WaitForTurnstileTokenResponse) => void,
) {
  const perform = async () => {
    try {
      const result = await waitForTurnstileToken({
        requestId: request.requestId,
        timeoutMs: request.timeoutMs,
        preTrigger: request.preTrigger,
        userAssist: createTurnstileUserAssist(request.requestId),
      })

      logger.debug("Turnstile token wait completed", {
        requestId: request.requestId ?? null,
        status: result.status,
        hasTurnstile: result.detection.hasTurnstile,
        score: result.detection.score,
        reasons: result.detection.reasons,
      })

      sendResponse({ success: true, ...result })
    } catch (error) {
      logger.warn("Turnstile token wait failed", {
        requestId: request.requestId ?? null,
        error: getErrorMessage(error),
      })
      sendResponse({ success: false, error: getErrorMessage(error) })
    }
  }

  void perform()
  return true
}

/**
 * Reads the page's public Turnstile site key without touching the widget.
 *
 * A key is usually already present in the markup; the short wait only covers a
 * late render. This never clicks anything, so it cannot consume the day's
 * check-in or start a challenge.
 */
export function handleReadTurnstileSitekey(
  request: { timeoutMs?: unknown },
  sendResponse: (res: {
    success: boolean
    sitekey: string | null
    action?: string | null
    cdata?: string | null
  }) => void,
) {
  const perform = async () => {
    try {
      const requested = Number(request?.timeoutMs)
      const timeoutMs =
        Number.isFinite(requested) && requested >= 0
          ? Math.min(10_000, requested)
          : TURNSTILE_SOLVER_SITEKEY_WAIT_MS
      const deadline = Date.now() + timeoutMs

      let widget = extractTurnstileWidgetParams()
      while (!widget.sitekey && Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, TURNSTILE_SOLVER_SITEKEY_POLL_MS),
        )
        widget = extractTurnstileWidgetParams()
      }

      logger.debug("Turnstile site key read", {
        found: Boolean(widget.sitekey),
        bound: Boolean(widget.action || widget.cdata),
        elapsedMs: Date.now() - (deadline - timeoutMs),
      })

      sendResponse({
        success: true,
        sitekey: widget.sitekey,
        action: widget.action,
        cdata: widget.cdata,
      })
    } catch (error) {
      logger.warn("Turnstile site key read failed", {
        error: getErrorMessage(error),
      })
      sendResponse({ success: false, sitekey: null, action: null, cdata: null })
    }
  }

  void perform()
  return true
}

/**
 * Handle native page check-in action trigger requests.
 *
 * Clicks the page action and observes any verification it opens. Server-side
 * status readback remains the caller's responsibility.
 */
export function handleTriggerCheckinPageAction(
  request: TriggerCheckinPageActionRequest,
  sendResponse: (res: TriggerCheckinPageActionResponse) => void,
) {
  const perform = async () => {
    try {
      // Any trigger kind may name a read-only render wait; the helper no-ops when
      // the trigger does not ask for one.
      if (request.trigger) {
        await waitForCheckinPageActionTarget(request.trigger)
      }
      const existingWidgets = capturePageVerificationWidgets()
      const result = triggerCheckinPageAction({
        requestId: request.requestId,
        trigger: request.trigger,
      })

      logger.debug("Check-in page action trigger completed", {
        requestId: request.requestId ?? null,
        status: result.status,
        reason: result.reason,
        clicked: result.clicked,
      })

      const verification = result.clicked
        ? await waitForPageVerification({
            requestId: request.requestId,
            existingWidgets,
            requestAssist: createTurnstileUserAssist(request.requestId)
              .requestAssist,
          })
        : undefined
      sendResponse({
        success: true,
        ...result,
        ...(verification ? { verification } : {}),
      })
    } catch (error) {
      logger.warn("Check-in page action trigger failed", {
        requestId: request.requestId ?? null,
        error: getErrorMessage(error),
      })
      sendResponse({ success: false, error: getErrorMessage(error) })
    }
  }
  void perform()

  return true
}
