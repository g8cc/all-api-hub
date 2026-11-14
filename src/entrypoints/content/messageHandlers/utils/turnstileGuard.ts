import {
  CHECKIN_PAGE_ACTION_TARGET_MAX_WAIT_MS,
  TURNSTILE_ASSIST_TURN_WAIT_MS,
  TURNSTILE_AUTO_ASSIST_MS,
  TURNSTILE_CONTAINER_SELECTOR,
  TURNSTILE_DEFAULT_WAIT_TIMEOUT_MS,
  TURNSTILE_IFRAME_SELECTOR,
  TURNSTILE_MANUAL_WAIT_MS,
  TURNSTILE_PAGE_API_POLL_MS,
  TURNSTILE_RESPONSE_FIELD_SELECTOR,
  TURNSTILE_SCRIPT_SELECTOR,
} from "~/constants/turnstile"
import { hasOtherPendingVerification } from "~/services/checkin/pageVerification"
import { createVerificationManualWindow } from "~/services/checkin/verificationManualWindow"
import { TURNSTILE_PRE_TRIGGER_KINDS } from "~/types/turnstile"
import type {
  CheckinPageActionTriggerResult,
  TurnstilePreTrigger,
  TurnstileTokenWaitResult,
  TurnstileWidgetDetection,
} from "~/types/turnstile"
import { createLogger } from "~/utils/core/logger"
import { sanitizeUrlForLog } from "~/utils/core/sanitizeUrlForLog"

/**
 * Unified logger scoped to Turnstile detection/auto-start helpers.
 */
const logger = createLogger("TurnstileGuard")

type TurnstileAutoStartAttempt = {
  attempted: boolean
  method: "click" | "none"
  reason: string
}

type TurnstileAutoStartState = {
  attempts: number
  lastAttemptAt: number
}

declare global {
  var __aahTurnstileAutoStartState:
    | Map<string, TurnstileAutoStartState>
    | undefined

  var __aahTurnstilePreTriggerState:
    | Map<string, TurnstileAutoStartState>
    | undefined
}

const TURNSTILE_AUTOSTART_MIN_INTERVAL_MS = 1000
const TURNSTILE_AUTOSTART_MAX_ATTEMPTS = 3

const PRETRIGGER_DEFAULT_MIN_INTERVAL_MS = 1200
const PRETRIGGER_DEFAULT_MAX_ATTEMPTS = 2
const PRETRIGGER_SETTLE_DELAY_MS = 600

const MAX_PATTERN_LENGTH = 200

const DEFAULT_CHECKIN_TRIGGER_CANDIDATE_SELECTOR =
  'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [onclick], [tabindex]:not([tabindex="-1"]), [class*="btn"], [class*="Btn"], [class*="button"], [class*="Button"]'
/**
 * Last-resort scan for deployments that style a plain container as the action.
 * Bounded so a large page cannot turn one lookup into a full DOM walk.
 */
const FALLBACK_CLICKABLE_SELECTOR = "div, span, p, li, strong, b, i, em"
const FALLBACK_CLICKABLE_LIMIT = 4_000
const DEFAULT_CHECKIN_TRIGGER_POSITIVE_PATTERN =
  "(签到|簽到|打卡|check\\s*in|checkin|check-in|daily\\s*(?:check|sign)|sign\\s*in|claim|领取|領取|收下|获取|獲取)"
const DEFAULT_CHECKIN_TRIGGER_NEGATIVE_PATTERN =
  "(已签到|已簽到|已打卡|已领取|已領取|已签到过|明日|明天|already|tomorrow|tonight)"

const DEFAULT_WAIT_TIMEOUT_MS = TURNSTILE_DEFAULT_WAIT_TIMEOUT_MS
const MIN_WAIT_TIMEOUT_MS = 500
const MAX_WAIT_TIMEOUT_MS = 30_000
const WAIT_POLL_INTERVAL_MS = 250

/**
 * Per-request throttling state for Turnstile auto-start clicks.
 *
 * Stored on `globalThis` so repeated invocations within the same content-script
 * lifetime share throttling limits.
 */
function getTurnstileAutoStartStateMap(): Map<string, TurnstileAutoStartState> {
  const existing = globalThis.__aahTurnstileAutoStartState
  if (existing) return existing

  const created = new Map<string, TurnstileAutoStartState>()
  globalThis.__aahTurnstileAutoStartState = created
  return created
}

/**
 * Clears any stored Turnstile auto-start throttling state for a request.
 */
function clearTurnstileAutoStartState(requestId?: string | null): void {
  const normalized = (requestId || "").trim()
  if (!normalized) return
  try {
    getTurnstileAutoStartStateMap().delete(normalized)
  } catch {
    // ignore
  }
}

/**
 * Per-request state for Turnstile pre-trigger clicks (e.g. clicking a "check-in"
 * button to render the widget).
 */
function getTurnstilePreTriggerStateMap(): Map<
  string,
  TurnstileAutoStartState
> {
  const existing = globalThis.__aahTurnstilePreTriggerState
  if (existing) return existing

  const created = new Map<string, TurnstileAutoStartState>()
  globalThis.__aahTurnstilePreTriggerState = created
  return created
}

/**
 * Clears stored Turnstile pre-trigger throttling state for a request.
 */
function clearTurnstilePreTriggerState(requestId?: string | null): void {
  const normalized = (requestId || "").trim()
  if (!normalized) return
  try {
    getTurnstilePreTriggerStateMap().delete(normalized)
  } catch {
    // ignore
  }
}

/**
 * Clears all Turnstile throttling state associated with a request.
 */
function clearTurnstileGuardState(requestId?: string | null): void {
  clearTurnstileAutoStartState(requestId)
  clearTurnstilePreTriggerState(requestId)
}

/**
 * Detect whether the current page contains Cloudflare Turnstile markers.
 *
 * This detector is intentionally conservative and uses stable DOM markers:
 * - Presence of a `name="cf-turnstile-response"` field
 * - `.cf-turnstile` container
 * - Turnstile iframe/script URLs
 */
export function detectTurnstileWidget(): TurnstileWidgetDetection {
  const reasons: string[] = []
  let score = 0

  const title = String(document.title ?? "")

  const currentUrl = (() => {
    try {
      return window.location.href
    } catch {
      return null
    }
  })()

  const hasResponseField = (() => {
    try {
      return Boolean(
        document.querySelector(TURNSTILE_RESPONSE_FIELD_SELECTOR) ??
          queryAllDeep(TURNSTILE_RESPONSE_FIELD_SELECTOR)[0],
      )
    } catch {
      return false
    }
  })()

  const hasContainer = (() => {
    try {
      return Boolean(
        document.querySelector(TURNSTILE_CONTAINER_SELECTOR) ??
          queryAllDeep(TURNSTILE_CONTAINER_SELECTOR)[0],
      )
    } catch {
      return false
    }
  })()

  const hasScript = (() => {
    try {
      return Boolean(document.querySelector(TURNSTILE_SCRIPT_SELECTOR))
    } catch {
      return false
    }
  })()

  const hasIframe = (() => {
    try {
      return Boolean(
        document.querySelector(TURNSTILE_IFRAME_SELECTOR) ??
          queryAllDeep(TURNSTILE_IFRAME_SELECTOR)[0],
      )
    } catch {
      return false
    }
  })()

  // Deployments may render the widget with data attributes only.
  const hasDataWidget = (() => {
    try {
      return Boolean(
        document.querySelector(
          "[data-turnstile-widget], [data-sitekey][data-callback]",
        ) ??
          queryAllDeep(
            "[data-turnstile-widget], [data-sitekey][data-callback]",
          )[0],
      )
    } catch {
      return false
    }
  })()

  if (hasResponseField) {
    score += 3
    reasons.push("cf-turnstile-response-field")
  }

  if (hasContainer) {
    score += 2
    reasons.push("cf-turnstile-class")
  }

  if (hasScript) {
    score += 1
    reasons.push("turnstile-script")
  }

  if (hasIframe) {
    score += 1
    reasons.push("turnstile-iframe")
  }

  if (hasDataWidget) {
    score += 2
    reasons.push("turnstile-data-widget")
  }

  const hasTurnstile = Boolean(
    hasResponseField || hasContainer || hasScript || hasIframe || hasDataWidget,
  )

  return {
    hasTurnstile,
    score,
    reasons,
    title,
    url: currentUrl,
  }
}

/**
 * Read the `cf-turnstile-response` token value from DOM fields.
 */
function readTurnstileTokenFromDom(): string | null {
  let fields: NodeListOf<Element> | null

  try {
    fields = document.querySelectorAll(TURNSTILE_RESPONSE_FIELD_SELECTOR)
  } catch {
    fields = null
  }

  if (!fields || fields.length === 0) return null

  for (const field of Array.from(fields)) {
    if (
      !(field instanceof HTMLInputElement) &&
      !(field instanceof HTMLTextAreaElement)
    ) {
      continue
    }

    const token = field.value.trim()
    if (token) {
      return token
    }
  }

  return null
}

/**
 * Best-effort click simulation that works across different widget wrappers.
 */
function simulateClick(target: HTMLElement) {
  try {
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
    target.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
  } catch {
    try {
      target.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      )
      target.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      )
    } catch {
      // ignore
    }
  }

  try {
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
  } catch {
    // ignore
  }

  try {
    target.click()
  } catch {
    // ignore
  }
}

/**
 * Resolve a stable click target used to "wake" Turnstile (best-effort).
 *
 * The widget is clicked through its container so a normal site flow (which may
 * register its own click handler on the wrapper) still runs; the iframe and a
 * `data-sitekey` host are fallbacks for deployments that render the widget
 * without the default class.
 */
function getTurnstileClickTarget(): HTMLElement | null {
  const candidates: string[] = [
    TURNSTILE_CONTAINER_SELECTOR,
    TURNSTILE_IFRAME_SELECTOR,
    "[data-turnstile-widget]",
    "[data-sitekey]",
  ]
  for (const selector of candidates) {
    const target = queryAllDeep(selector).find((element) =>
      isActionable(element),
    )
    if (target instanceof HTMLElement) return target
  }
  return null
}

/**
 * Compile a case-insensitive regex from a pattern string.
 * Falls back to the provided regex when compilation fails.
 */
function compileCaseInsensitiveRegex(
  pattern: string | undefined,
  fallback: RegExp,
): RegExp {
  const normalized = typeof pattern === "string" ? pattern.trim() : ""
  if (!normalized) return fallback
  if (normalized.length > MAX_PATTERN_LENGTH) return fallback
  try {
    return new RegExp(normalized, "i")
  } catch {
    return fallback
  }
}

/**
 * Compile an optional case-insensitive regex from a pattern string.
 */
function compileOptionalCaseInsensitiveRegex(
  pattern: string | undefined,
  fallback: RegExp | null = null,
): RegExp | null {
  const normalized = typeof pattern === "string" ? pattern.trim() : ""
  if (!normalized) return fallback
  if (normalized.length > MAX_PATTERN_LENGTH) return fallback
  try {
    return new RegExp(normalized, "i")
  } catch {
    return fallback
  }
}

/**
 * Returns the label for a pre-trigger when available.
 */
function getPreTriggerLabel(preTrigger: TurnstilePreTrigger): string | null {
  if (preTrigger.kind === "clickSelector" || preTrigger.kind === "clickText") {
    const normalized = String(preTrigger.label ?? "").trim()
    return normalized ? normalized : null
  }
  return null
}

/**
 * Walk the document and every open shadow root, so an action rendered by a web
 * component is still reachable.
 */
function collectShadowRoots(
  root: Document | ShadowRoot = document,
): ShadowRoot[] {
  const roots: ShadowRoot[] = []
  const queue: Array<{ node: ParentNode; depth: number }> = [
    { node: root, depth: 0 },
  ]
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > 3) continue
    let elements: Element[]
    try {
      elements = Array.from(current.node.querySelectorAll("*"))
    } catch {
      continue
    }
    for (const element of elements) {
      const shadow = (element as HTMLElement).shadowRoot
      if (shadow) {
        roots.push(shadow)
        queue.push({ node: shadow, depth: current.depth + 1 })
      }
    }
  }
  return roots
}

/** Select elements in the document and in every open shadow root. */
function queryAllDeep(
  selector: string,
  limit = Number.POSITIVE_INFINITY,
): Element[] {
  const matches: Element[] = []
  const query = (scope: ParentNode) => {
    if (matches.length >= limit) return
    try {
      matches.push(...Array.from(scope.querySelectorAll(selector)))
    } catch {
      /* An invalid selector yields no candidates. */
    }
  }
  query(document)
  for (const root of collectShadowRoots()) {
    if (matches.length >= limit) break
    query(root)
  }
  return matches.slice(0, limit)
}

/** Whether the element can actually receive a native click right now. */
function isActionable(element: Element): boolean {
  if (!element.isConnected) return false
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("inert") || node.hasAttribute("hidden")) return false
    if (node.getAttribute("aria-hidden") === "true") return false
    const style = getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden") return false
    if (style.pointerEvents === "none") return false
  }
  const disabled =
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("disabled")
  return !disabled
}

/**
 * The action's own label. Container text is deliberately excluded: a card that
 * wraps the whole check-in panel would otherwise match on its children's copy
 * and sort ahead of the real button.
 */
function readActionLabel(element: Element): string {
  const attributes = [
    "aria-label",
    "title",
    "value",
    "data-label",
    "data-title",
  ]
    .map((name) => element.getAttribute(name) ?? "")
    .filter(Boolean)
  const ownText = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ")
  // A styled container usually wraps its caption in a span. Accept that text only
  // when it is short enough to be a caption rather than page copy.
  let caption = ownText
  if (!caption.trim()) {
    const nested = String(element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
    if (nested.length <= CAPTION_MAX_LENGTH) caption = nested
  }
  const text = [caption, ...attributes].join(" ").replace(/\s+/g, " ").trim()
  return text
}

/** Longest label a control caption may have before it reads as page copy. */
const CAPTION_MAX_LENGTH = 24

/** Prefer an element that looks like a control over a decorative wrapper. */
function actionabilityScore(element: Element): number {
  let score = 0
  const tag = element.tagName
  if (tag === "BUTTON") score += 60
  else if (tag === "A") score += 45
  else if (tag === "INPUT") score += 40
  else if (element.getAttribute("role") === "button") score += 40
  else score += 10
  if (element.hasAttribute("onclick")) score += 15
  const className = element.getAttribute("class") ?? ""
  if (/btn|button|submit|check/i.test(className)) score += 12
  if (element.getAttribute("tabindex") !== null) score += 5
  const style = getComputedStyle(element)
  if (style.cursor === "pointer") score += 12
  const rect = element.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) score += 10
  // A very long label is page copy, not a control caption.
  const label = readActionLabel(element)
  if (label.length > 24) score -= 10
  return score
}

/**
 * Finds a clickable element by its own label, using the provided patterns.
 *
 * Candidates come from the caller's selector first. When that finds nothing,
 * plain containers are scanned so a deployment that styles a `div` as its
 * check-in action is still recognised.
 */
function findClickableByText(params: {
  candidateSelector: string
  positive: RegExp
  negative?: RegExp | null
}): HTMLElement | null {
  const { candidateSelector, positive, negative } = params

  const score = (node: Element): number | null => {
    if (!(node instanceof HTMLElement)) return null
    if (!isActionable(node)) return null
    const label = readActionLabel(node)
    if (!label) return null
    if (!positive.test(label)) return null
    if (negative && negative.test(label)) return null
    return actionabilityScore(node)
  }

  const pick = (candidates: Element[]): HTMLElement | null => {
    let best: { element: HTMLElement; score: number } | null = null
    for (const candidate of candidates) {
      const value = score(candidate)
      if (value === null) continue
      if (!best || value > best.score) {
        best = { element: candidate as HTMLElement, score: value }
      }
    }
    return best?.element ?? null
  }

  const primary = pick(queryAllDeep(candidateSelector))
  if (primary) return primary

  // Fallback: the action may be a styled container rather than a control.
  return pick(
    queryAllDeep(FALLBACK_CLICKABLE_SELECTOR, FALLBACK_CLICKABLE_LIMIT),
  )
}

/**
 * Resolve the effective pre-trigger throttle configuration.
 */
function resolvePreTriggerThrottle(preTrigger: TurnstilePreTrigger): {
  maxAttempts: number
  minIntervalMs: number
} {
  if (preTrigger.kind === "none") {
    return {
      maxAttempts: PRETRIGGER_DEFAULT_MAX_ATTEMPTS,
      minIntervalMs: PRETRIGGER_DEFAULT_MIN_INTERVAL_MS,
    }
  }

  const throttle = preTrigger.throttle

  const rawMaxAttempts = throttle?.maxAttempts
  const maxAttempts =
    typeof rawMaxAttempts === "number" && Number.isFinite(rawMaxAttempts)
      ? Math.max(0, Math.floor(rawMaxAttempts))
      : PRETRIGGER_DEFAULT_MAX_ATTEMPTS

  const rawMinInterval = throttle?.minIntervalMs
  const minIntervalMs =
    typeof rawMinInterval === "number" && Number.isFinite(rawMinInterval)
      ? Math.max(0, Math.floor(rawMinInterval))
      : PRETRIGGER_DEFAULT_MIN_INTERVAL_MS

  return { maxAttempts, minIntervalMs }
}

/**
 * Convert DOM click details into a runtime-message-safe action result.
 */
function toActionTriggerResult(params: {
  status: CheckinPageActionTriggerResult["status"]
  clicked: boolean
  reason: CheckinPageActionTriggerResult["reason"]
  detection: TurnstileWidgetDetection
  target?: HTMLElement
  error?: string
}): CheckinPageActionTriggerResult {
  return {
    status: params.status,
    clicked: params.clicked,
    reason: params.reason,
    detection: params.detection,
    ...(params.target
      ? {
          target: {
            tagName: params.target.tagName.toLowerCase(),
            text: String(params.target.textContent ?? "")
              .trim()
              .slice(0, 80),
          },
        }
      : {}),
    ...(params.error ? { error: params.error } : {}),
  }
}

/**
 * Resolve the configured check-in action target without clicking it.
 */
function resolveCheckinPageActionTarget(
  trigger: TurnstilePreTrigger,
): HTMLElement | null {
  if (trigger.kind === TURNSTILE_PRE_TRIGGER_KINDS.ClickSelector) {
    const selector = String(trigger.selector ?? "").trim()
    if (!selector) return null
    try {
      const el = document.querySelector(selector)
      return el instanceof HTMLElement ? el : null
    } catch {
      return null
    }
  }

  if (trigger.kind === TURNSTILE_PRE_TRIGGER_KINDS.ClickText) {
    const positive = compileCaseInsensitiveRegex(trigger.positivePattern, /$^/)
    const negative = compileOptionalCaseInsensitiveRegex(
      trigger.negativePattern,
    )
    const candidateSelector =
      typeof trigger.candidateSelector === "string" &&
      trigger.candidateSelector.trim()
        ? trigger.candidateSelector.trim()
        : DEFAULT_CHECKIN_TRIGGER_CANDIDATE_SELECTOR

    return findClickableByText({ candidateSelector, positive, negative })
  }

  if (trigger.kind === TURNSTILE_PRE_TRIGGER_KINDS.CheckinButton) {
    const positive = compileCaseInsensitiveRegex(
      trigger.positivePattern,
      new RegExp(DEFAULT_CHECKIN_TRIGGER_POSITIVE_PATTERN, "i"),
    )
    const negative = compileCaseInsensitiveRegex(
      trigger.negativePattern,
      new RegExp(DEFAULT_CHECKIN_TRIGGER_NEGATIVE_PATTERN, "i"),
    )
    const candidateSelector =
      typeof trigger.candidateSelector === "string" &&
      trigger.candidateSelector.trim()
        ? trigger.candidateSelector.trim()
        : DEFAULT_CHECKIN_TRIGGER_CANDIDATE_SELECTOR

    return findClickableByText({ candidateSelector, positive, negative })
  }

  return null
}

/**
 * How long a label-based action is given to render.
 *
 * The check-in page is usually opened in a fresh temporary window, and many
 * dashboards fill their action in from an API response, so the button can be a
 * moment behind the navigation.
 */
const DEFAULT_CHECKIN_ACTION_WAIT_MS = 5_000

/** Waits for the configured native action to render without clicking it. */
export async function waitForCheckinPageActionTarget(
  trigger: TurnstilePreTrigger,
): Promise<void> {
  if (!trigger || trigger.kind === TURNSTILE_PRE_TRIGGER_KINDS.None) return
  const requested = "targetWaitMs" in trigger ? trigger.targetWaitMs : undefined
  const explicit =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(CHECKIN_PAGE_ACTION_TARGET_MAX_WAIT_MS, Math.max(0, requested))
      : undefined
  // A selector names one exact element: waiting for it is the caller's choice.
  // A label-based action is resolved by reading the page, so the default wait
  // applies unless the caller asked for a different budget.
  const timeout =
    explicit ??
    (trigger.kind === TURNSTILE_PRE_TRIGGER_KINDS.ClickSelector
      ? 0
      : DEFAULT_CHECKIN_ACTION_WAIT_MS)
  if (timeout <= 0) return
  const deadline = Date.now() + timeout
  while (!resolveCheckinPageActionTarget(trigger) && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now()),
      ),
    )
  }
}

/** Bring the action into view so a native click lands on it. */
function revealActionTarget(target: HTMLElement) {
  try {
    const rect = target.getBoundingClientRect()
    const inViewport =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || 0) &&
      rect.right <= (window.innerWidth || 0)
    if (!inViewport)
      target.scrollIntoView({ block: "center", inline: "center" })
  } catch {
    /* Scrolling is best-effort. */
  }
}

/**
 * Trigger the page's own check-in action using the same safe target selection
 * used by Turnstile pre-trigger waits. This helper never decides whether
 * check-in succeeded; callers must verify server-side account status.
 */
export function triggerCheckinPageAction(params: {
  requestId?: string | null
  trigger?: TurnstilePreTrigger
  detection?: TurnstileWidgetDetection
}): CheckinPageActionTriggerResult {
  const detection = params.detection ?? detectTurnstileWidget()
  const requestId = (params.requestId || "").trim()
  if (!requestId) {
    return toActionTriggerResult({
      status: "error",
      clicked: false,
      reason: "missingRequestId",
      detection,
    })
  }

  const trigger = params.trigger
  if (!trigger || trigger.kind === TURNSTILE_PRE_TRIGGER_KINDS.None) {
    return toActionTriggerResult({
      status: "target_not_found",
      clicked: false,
      reason: "disabled",
      detection,
    })
  }

  const { maxAttempts, minIntervalMs } = resolvePreTriggerThrottle(trigger)
  const stateMap = getTurnstilePreTriggerStateMap()
  const now = Date.now()
  const current = stateMap.get(requestId) ?? { attempts: 0, lastAttemptAt: 0 }

  if (current.attempts >= maxAttempts) {
    return toActionTriggerResult({
      status: "throttled",
      clicked: false,
      reason: "maxAttempts",
      detection,
    })
  }

  if (now - current.lastAttemptAt < minIntervalMs) {
    return toActionTriggerResult({
      status: "throttled",
      clicked: false,
      reason: "throttled",
      detection,
    })
  }

  const target = resolveCheckinPageActionTarget(trigger)
  if (!target) {
    logger.debug("Check-in page action skipped: no target found", {
      requestId,
      kind: trigger.kind,
      label: getPreTriggerLabel(trigger),
      url: detection.url ? sanitizeUrlForLog(detection.url) : null,
    })
    return toActionTriggerResult({
      status: "target_not_found",
      clicked: false,
      reason: "noTarget",
      detection,
    })
  }

  stateMap.set(requestId, {
    attempts: current.attempts + 1,
    lastAttemptAt: now,
  })

  try {
    // A native check-in is a mutation: dispatch exactly one click event.
    revealActionTarget(target)
    target.click()
    logger.debug("Check-in page action via click()", {
      requestId,
      kind: trigger.kind,
      label: getPreTriggerLabel(trigger),
      targetText: String(target.textContent ?? "")
        .trim()
        .slice(0, 80),
      url: detection.url ? sanitizeUrlForLog(detection.url) : null,
    })
    return toActionTriggerResult({
      status: "clicked",
      clicked: true,
      reason: "clicked",
      detection,
      target,
    })
  } catch (error) {
    return toActionTriggerResult({
      status: "error",
      clicked: false,
      reason: "unexpectedError",
      detection,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Best-effort: attempt to start Turnstile verification via a stable click target.
 *
 * Note: This helper does not attempt to solve Turnstile. It only dispatches a
 * user-like click and relies on the legitimate widget to produce a token.
 */
export function maybeAutoStartTurnstile(params: {
  requestId?: string | null
  detection?: TurnstileWidgetDetection
}): TurnstileAutoStartAttempt {
  const requestId = (params.requestId || "").trim()
  if (!requestId) {
    return { attempted: false, method: "none", reason: "missingRequestId" }
  }

  const stateMap = getTurnstileAutoStartStateMap()
  const now = Date.now()
  const current = stateMap.get(requestId) ?? { attempts: 0, lastAttemptAt: 0 }

  if (current.attempts >= TURNSTILE_AUTOSTART_MAX_ATTEMPTS) {
    return { attempted: false, method: "none", reason: "maxAttempts" }
  }

  if (now - current.lastAttemptAt < TURNSTILE_AUTOSTART_MIN_INTERVAL_MS) {
    return { attempted: false, method: "none", reason: "throttled" }
  }

  const target = getTurnstileClickTarget()
  if (!target) {
    return { attempted: false, method: "none", reason: "noTarget" }
  }

  stateMap.set(requestId, {
    attempts: current.attempts + 1,
    lastAttemptAt: now,
  })

  try {
    simulateClick(target)
    logger.debug("Turnstile auto-start via click()", {
      requestId,
      url: params.detection?.url
        ? sanitizeUrlForLog(params.detection.url)
        : null,
    })
    return { attempted: true, method: "click", reason: "clicked" }
  } catch {
    return { attempted: false, method: "none", reason: "unexpectedError" }
  }
}

/**
 * Normalize a user-provided timeout into a safe bounded value (ms).
 */
function normalizeTimeoutMs(timeoutMs: unknown): number {
  const raw =
    typeof timeoutMs === "number"
      ? timeoutMs
      : typeof timeoutMs === "string"
        ? Number(timeoutMs)
        : NaN

  const resolved = Number.isFinite(raw) ? raw : DEFAULT_WAIT_TIMEOUT_MS
  return Math.min(Math.max(resolved, MIN_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS)
}

/**
 * Wait for a Turnstile token to appear in the DOM.
 */
const MAX_ASSIST_DELAY_MS = 120_000
const MAX_PAGE_TOKEN_LENGTH = 4_096

export type TurnstilePageTokenRead = (params: {
  allowExecute: boolean
}) => Promise<string | null>

/**
 * Optional hand-off used when the official widget does not complete on its own.
 * Interactive Turnstile checks require a trusted user gesture, which a content
 * script cannot synthesize. The temp window is brought forward and the wait
 * continues until the widget writes a token.
 */
export type TurnstileUserAssist = {
  /** Quiet period before the window is brought forward. */
  autoAttemptMs?: number
  /** Total wait budget once the user is asked to finish verification. */
  manualTimeoutMs?: number
  /** Minimum gap between official page-API reads. */
  pageTokenIntervalMs?: number
  requestAssist: () => Promise<unknown> | unknown
  readPageToken?: TurnstilePageTokenRead
}

/**
 * Accept a non-negative assist delay without the short-wait clamp.
 */
function normalizeAssistDelay(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback
  }
  return Math.min(value, MAX_ASSIST_DELAY_MS)
}

/**
 * Read a token from the page-world Turnstile client, if the caller provided one.
 */
async function readAssistedPageToken(
  assist: TurnstileUserAssist | undefined,
  allowExecute: boolean,
): Promise<string | null> {
  if (!assist?.readPageToken) return null
  try {
    const token = await assist.readPageToken({ allowExecute })
    if (typeof token !== "string") return null
    const normalized = token.trim()
    if (!normalized || normalized.length > MAX_PAGE_TOKEN_LENGTH) return null
    return normalized
  } catch {
    return null
  }
}

/**
 * Wait for a Turnstile token to appear in the DOM or the official page API.
 */
export async function waitForTurnstileToken(params: {
  requestId?: string | null
  timeoutMs?: unknown
  preTrigger?: TurnstilePreTrigger
  userAssist?: TurnstileUserAssist
}): Promise<TurnstileTokenWaitResult> {
  let detection = detectTurnstileWidget()

  const preTriggerEnabled = Boolean(
    params.preTrigger && params.preTrigger.kind !== "none",
  )
  const assist = params.userAssist

  const existing = readTurnstileTokenFromDom()
  if (existing) {
    clearTurnstileGuardState(params.requestId)
    return { status: "token_obtained", token: existing, detection }
  }

  const initialPageToken = await readAssistedPageToken(assist, false)
  if (initialPageToken) {
    clearTurnstileGuardState(params.requestId)
    return { status: "token_obtained", token: initialPageToken, detection }
  }

  if (!detection.hasTurnstile && !preTriggerEnabled) {
    clearTurnstileGuardState(params.requestId)
    return { status: "not_present", token: null, detection }
  }

  const timeoutMs = normalizeTimeoutMs(params.timeoutMs)
  const startedAt = Date.now()
  let deadline = startedAt + timeoutMs
  const autoAttemptMs = assist
    ? Math.min(
        timeoutMs,
        normalizeAssistDelay(assist.autoAttemptMs, TURNSTILE_AUTO_ASSIST_MS),
      )
    : timeoutMs
  const assistAt = startedAt + autoAttemptMs
  const pageTokenIntervalMs = normalizeAssistDelay(
    assist?.pageTokenIntervalMs,
    TURNSTILE_PAGE_API_POLL_MS,
  )
  let assistRequested = false
  let assistDeclined = false
  let chainAssistRequested = false
  let lastPageTokenReadAt = 0
  let sawTurnstile = detection.hasTurnstile
  // Set while the assist waits for its turn in front of the user, so the wait can
  // outlast the normal timeout without blocking token detection.
  let assistPendingUntil: number | null = null
  const manualWindow = createVerificationManualWindow(
    assist ? params.requestId : undefined,
  )
  const activeDeadline = () =>
    Math.max(deadline, assistPendingUntil ?? 0, manualWindow.getDeadline())

  const requestAssistPresentation = () => {
    // The assist can wait for its turn behind another verification window, and
    // the widget may still resolve on its own while it waits. Keep polling for a
    // token instead of blocking until the presentation settles.
    assistPendingUntil = Date.now() + TURNSTILE_ASSIST_TURN_WAIT_MS
    const manualWindowMs = Math.max(
      timeoutMs,
      normalizeAssistDelay(assist?.manualTimeoutMs, TURNSTILE_MANUAL_WAIT_MS),
    )
    void Promise.resolve()
      .then(() => assist?.requestAssist())
      .then(
        (accepted) => accepted !== false,
        () => true,
      )
      .then((accepted) => {
        assistPendingUntil = null
        if (!accepted) {
          assistDeclined = true
          return
        }
        // The window only reaches the user now, so the manual window they need
        // to finish the challenge starts here.
        deadline = Math.max(deadline, Date.now() + manualWindowMs)
      })
  }

  try {
    while (Date.now() < activeDeadline()) {
      const token = readTurnstileTokenFromDom()
      if (token) {
        detection = detectTurnstileWidget()
        clearTurnstileGuardState(params.requestId)
        return { status: "token_obtained", token, detection }
      }

      const now = Date.now()
      if (
        assist?.readPageToken &&
        now - lastPageTokenReadAt >= pageTokenIntervalMs
      ) {
        lastPageTokenReadAt = now
        const pageToken = await readAssistedPageToken(assist, sawTurnstile)
        if (pageToken) {
          detection = detectTurnstileWidget()
          clearTurnstileGuardState(params.requestId)
          return { status: "token_obtained", token: pageToken, detection }
        }
      }

      detection = detectTurnstileWidget()
      if (detection.hasTurnstile) {
        sawTurnstile = true
        maybeAutoStartTurnstile({ requestId: params.requestId, detection })
      } else if (preTriggerEnabled) {
        const attempt = triggerCheckinPageAction({
          requestId: params.requestId,
          trigger: params.preTrigger,
          detection,
        })

        if (attempt.clicked) {
          await new Promise((resolve) =>
            setTimeout(resolve, PRETRIGGER_SETTLE_DELAY_MS),
          )
          continue
        }
      }

      if (
        assist &&
        !assistRequested &&
        !assistDeclined &&
        sawTurnstile &&
        Date.now() >= assistAt
      ) {
        assistRequested = true
        requestAssistPresentation()
        continue
      }

      // A page can chain layers: a picture code or slider is answered first and
      // only then renders the Turnstile widget. Invite the user for that layer
      // instead of letting the wait expire on a widget that cannot appear yet.
      if (
        assist &&
        !assistRequested &&
        !assistDeclined &&
        !chainAssistRequested &&
        Date.now() >= assistAt &&
        hasOtherPendingVerification()
      ) {
        chainAssistRequested = true
        requestAssistPresentation()
        continue
      }

      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS))
    }

    detection = detectTurnstileWidget()
    clearTurnstileGuardState(params.requestId)

    if (!sawTurnstile && !chainAssistRequested) {
      return { status: "not_present", token: null, detection }
    }

    return { status: "timeout", token: null, detection }
  } finally {
    manualWindow.dispose()
  }
}
