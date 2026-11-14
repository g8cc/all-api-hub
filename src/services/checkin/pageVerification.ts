import {
  TURNSTILE_ASSIST_TURN_WAIT_MS,
  TURNSTILE_AUTO_ASSIST_MS,
  TURNSTILE_CONTAINER_SELECTOR,
  TURNSTILE_IFRAME_SELECTOR,
  TURNSTILE_MANUAL_WAIT_MS,
  TURNSTILE_RESPONSE_FIELD_SELECTOR,
} from "~/constants/turnstile"
import type {
  PageVerificationProvider,
  PageVerificationResult,
} from "~/types/turnstile"

import { createVerificationManualWindow } from "./verificationManualWindow"

const APPEARANCE_WAIT_MS = 2_000
const POLL_INTERVAL_MS = 250

/**
 * A page can chain verification layers (a slider then a vendor widget, Turnstile
 * then an image code, ...). Each finished layer may reveal the next, so the
 * observer keeps watching instead of reporting success after the first one.
 */
const MAX_VERIFICATION_LAYERS = 3

// Scripts and page text alone do not establish that this action needs a captcha.
const WIDGETS = [
  {
    provider: "turnstile",
    widget: `${TURNSTILE_CONTAINER_SELECTOR}, ${TURNSTILE_IFRAME_SELECTOR}`,
    response: TURNSTILE_RESPONSE_FIELD_SELECTOR,
  },
  {
    provider: "recaptcha",
    widget:
      '.g-recaptcha, iframe[src*="/recaptcha/api2/anchor"], iframe[src*="/recaptcha/api2/bframe"], iframe[src*="/recaptcha/enterprise/anchor"], iframe[src*="/recaptcha/enterprise/bframe"]',
    response: '[name="g-recaptcha-response"]',
  },
  {
    provider: "hcaptcha",
    widget: '.h-captcha, iframe[src*="hcaptcha.com/captcha"]',
    response: '[name="h-captcha-response"]',
  },
] as const

type ObservedVerification = {
  provider: Exclude<
    PageVerificationResult,
    { status: "not_present" }
  >["provider"]
  /**
   * Elements that identify this layer. They are remembered once the layer is
   * done, so a still-present widget is not reported again while the page shows
   * its next challenge inside the same container.
   */
  fingerprint?: Element[]
  isPending: () => boolean
}

/** Ignore detached or explicitly hidden verification UI, including ancestors. */
function isShown(element: Element): boolean {
  if (!element.isConnected) return false
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (
      node.hasAttribute("hidden") ||
      node.getAttribute("aria-hidden") === "true" ||
      (node.tagName === "DIALOG" && !node.hasAttribute("open")) ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return false
  }
  return true
}

/** Label text that names a captcha answer, used only to locate its field. */
const CAPTCHA_HINT =
  /captcha|verification\s*code|security\s*code|verify\s*code|check\s*code|验证码|驗證碼|校验码|校驗碼|图形码|圖形碼|动态码|動態碼/i

/** Image resources that are captcha pictures whatever their visible name. */
const CAPTCHA_IMAGE_SRC =
  /captcha|captch|vcode|yzm|验证码|驗證碼|seccode|verifycode|checkcode|randomcode|rand_code|validcode/i

/**
 * Wording that only a code challenge uses. The primary rule keeps its narrower
 * pattern; this one also accepts a bare 验证码 prompt.
 */
const CODE_CHALLENGE_HINT =
  /(?:输入|輸入|填写|填寫|请输).{0,15}(?:验证码|驗證碼|字符|图|圖)|验证码|驗證碼|图形码|圖形碼/i

/** Slider wording, used when the control itself has no vendor class. */
const SLIDER_HINT = /拖动|拖動|滑动|滑動|滑块|滑塊|slide|drag|swipe|拼图|拼圖/i

/** Read semantic labels and resource paths without examining entered answers. */
function hasCaptchaHint(element: Element): boolean {
  return CAPTCHA_HINT.test(
    ["alt", "placeholder", "aria-label", "name", "id", "src"]
      .map((attribute) => element.getAttribute(attribute) ?? "")
      .join(" "),
  )
}

const IMAGE_INSTRUCTION =
  /(?:enter|type).{0,40}(?:image|picture|characters)|(?:select|click).{0,70}(?:image|picture|shapes)|(?:drag|slide).{0,60}(?:puzzle|verify|verification)|rotate.{0,40}(?:image|picture)|图形验证码|圖片驗證碼|图片验证码|(?:输入|輸入).{0,15}(?:图|圖|字符)|(?:点选|點選|点击|點擊|拖动|拖動|滑动|滑動|旋转|旋轉).{0,30}(?:图|圖|验证|驗證)/i

/** Require an image resource, drawing surface or image background. */
function hasChallengeSurface(element: Element): boolean {
  return (
    isShown(element) &&
    (element.tagName === "CANVAS" ||
      (element.tagName === "IMG" && !!element.getAttribute("src")) ||
      getComputedStyle(element).backgroundImage.startsWith("url("))
  )
}

/** Find local verification UI without requiring a vendor's CSS naming. */
/**
 * A captcha picture is often served from an opaque path, so accept the resource
 * name, an explicit hint, or a refresh affordance next to it.
 */
function looksLikeCaptchaImage(element: Element): boolean {
  if (element.tagName !== "IMG") return false
  const src = element.getAttribute("src") ?? ""
  if (CAPTCHA_IMAGE_SRC.test(src)) return true
  if (hasCaptchaHint(element)) return true
  const nearby = (element.parentElement?.textContent ?? "").slice(0, 200)
  return /换一张|換一張|刷新|看不清|refresh/i.test(nearby)
}

/** Visible text fields that could carry a code answer. */
function visibleAnswerFields(scope: ParentNode): HTMLInputElement[] {
  const selector =
    'input:not([type="hidden"]):not([type="password"]):not([type="email"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="submit"]):not([type="button"]), textarea'
  let inputs: Element[]
  try {
    inputs = Array.from(scope.querySelectorAll(selector))
  } catch {
    return []
  }
  return inputs
    .filter(
      (input): input is HTMLInputElement => input instanceof HTMLInputElement,
    )
    .filter((input) => isShown(input) && !input.disabled)
}

/** Whether the answer field announces itself as the captcha answer. */
function isCaptchaAnswerInput(input: HTMLInputElement): boolean {
  if (hasCaptchaHint(input)) return true
  if (input.maxLength > 0 && input.maxLength <= 8) {
    const nearby = (input.parentElement?.textContent ?? "").slice(0, 120)
    if (CAPTCHA_HINT.test(nearby)) return true
  }
  return Array.from(input.labels ?? []).some((label) =>
    CAPTCHA_HINT.test(label.textContent ?? ""),
  )
}

/** Open shadow roots, bounded in depth, so a challenge inside a web component is seen. */
function collectShadowRoots(root: ParentNode = document): ShadowRoot[] {
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

/**
 * Query the light DOM first and only walk shadow roots when it finds nothing, so
 * a page without web components costs one selector query per observation.
 */
export function queryAllDeep(selector: string): Element[] {
  let matches: Element[]
  try {
    matches = Array.from(document.querySelectorAll(selector))
  } catch {
    return []
  }
  if (matches.length) return matches
  for (const root of collectShadowRoots()) {
    try {
      matches.push(...Array.from(root.querySelectorAll(selector)))
    } catch {
      /* A malformed selector must not break observation. */
    }
  }
  return matches
}

/**
 * Deployments keep inventing their own captcha markup, so recognise a few more
 * shapes than the vendor rules do: shadow-DOM widgets, pictures served from an
 * opaque path, and sliders that carry no vendor class.
 *
 * Only runs when the primary rules found nothing, so a page that already works
 * keeps its previous classification.
 */
function observeExtendedVerification(
  excluding?: ReadonlySet<Element>,
): ObservedVerification | undefined {
  const vendor = observeShadowVendorWidget(excluding)
  if (vendor) return vendor
  return observeCodePicture(excluding) ?? observeSlider(excluding)
}

/** Vendor widgets rendered inside a shadow root or with data attributes only. */
function observeShadowVendorWidget(
  excluding?: ReadonlySet<Element>,
): ObservedVerification | undefined {
  for (const widget of WIDGETS) {
    const active = queryAllDeep(widget.widget).filter(
      (element) =>
        isShown(element) &&
        !excluding?.has(element) &&
        !element.closest('.grecaptcha-badge, [data-size="invisible"]') &&
        !/[?&]size=invisible\b/i.test(element.getAttribute("src") ?? ""),
    )
    if (!active.length) continue
    return {
      provider: widget.provider,
      fingerprint: active,
      isPending: () =>
        !hasActiveWidgetResponse(widget, active) && active.some(isShown),
    }
  }
  return undefined
}

/** A picture code whose file name says nothing, identified by its surroundings. */
function observeCodePicture(
  excluding?: ReadonlySet<Element>,
): ObservedVerification | undefined {
  const scopes = new Set<Element>()
  for (const surface of queryAllDeep(
    "img, canvas, svg, [style*='background']",
  )) {
    if (!hasChallengeSurface(surface)) continue
    if (excluding?.has(surface)) continue
    if (
      !looksLikeCaptchaImage(surface) &&
      !CODE_CHALLENGE_HINT.test(scopeText(surface))
    ) {
      continue
    }
    let scope: Element | null = surface.parentElement
    for (
      let depth = 0;
      scope && depth < 4;
      depth++, scope = scope.parentElement
    ) {
      if (scope === document.body || scope === document.documentElement) break
      if (excluding?.has(scope)) break
      scopes.add(scope)
      if (scope.matches('[role="dialog"], dialog, form, section')) break
    }
  }

  for (const scope of scopes) {
    if (!isShown(scope)) continue
    const surfaces = Array.from(
      scope.querySelectorAll("img, canvas, svg, [style*='background']"),
    ).filter(hasChallengeSurface)
    if (!surfaces.length) continue
    const namedAnswers = visibleAnswerFields(scope).filter(isCaptchaAnswerInput)
    const text = (scope.textContent ?? "").slice(0, 2_000)
    const pictureIsCaptcha = surfaces.some(looksLikeCaptchaImage)
    // A captcha picture with one plain field beside it is a code challenge even
    // when the field's own markup says nothing.
    const answers =
      namedAnswers.length ||
      (pictureIsCaptcha && visibleAnswerFields(scope).length === 1)
    if (!answers) continue
    if (pictureIsCaptcha || CODE_CHALLENGE_HINT.test(text)) {
      return {
        provider: "image",
        fingerprint: [scope],
        isPending: () => isShown(scope),
      }
    }
  }
  return undefined
}

/** A drag/slide challenge that carries no vendor class or picture. */
function observeSlider(
  excluding?: ReadonlySet<Element>,
): ObservedVerification | undefined {
  for (const handle of queryAllDeep(
    '[role="slider"], input[type="range"], [draggable="true"], [class*="slide"], [class*="slider"]',
  )) {
    if (!isShown(handle) || excluding?.has(handle)) continue
    let scope: Element | null = handle.parentElement
    for (
      let depth = 0;
      scope && depth < 4;
      depth++, scope = scope.parentElement
    ) {
      if (scope === document.body || scope === document.documentElement) break
      if (excluding?.has(scope)) break
      if (!SLIDER_HINT.test((scope.textContent ?? "").slice(0, 400))) continue
      if (!isShown(scope)) break
      const challenge = scope
      return {
        provider: "interactive",
        fingerprint: [challenge],
        isPending: () => isShown(challenge),
      }
    }
  }
  return undefined
}

/** Nearby wording of a surface, used to judge what a picture is for. */
function scopeText(element: Element): string {
  return (element.parentElement?.textContent ?? "").slice(0, 300)
}

/**
 * Finds a verification challenge that is drawn rather than labelled.
 *
 * Custom captchas rarely carry a recognizable name, so their painted surface —
 * an image, a canvas or a styled box — next to an input hint is the evidence.
 */
function observeGenericVerification(): ObservedVerification | undefined {
  const scopes = new Set<Element>()
  for (const surface of document.querySelectorAll(
    "img, canvas, [style*='background']",
  )) {
    if (!hasChallengeSurface(surface)) continue
    let scope = surface.parentElement
    for (
      let depth = 0;
      scope && depth < 4;
      depth++, scope = scope.parentElement
    ) {
      if (scope === document.body || scope === document.documentElement) break
      scopes.add(scope)
      if (scope.matches('[role="dialog"], dialog, form, section')) break
    }
  }
  for (const scope of scopes) {
    if (!isShown(scope)) continue
    const text = (scope.textContent ?? "").slice(0, 2_000)
    const instruction = IMAGE_INSTRUCTION.test(text)
    const surfaces = Array.from(
      scope.querySelectorAll("img, canvas, [style*='background']"),
    ).filter(hasChallengeSurface)
    const visualHint = surfaces.some(hasCaptchaHint)
    const inputs = Array.from(
      scope.querySelectorAll<HTMLInputElement>(
        'input:not([type="hidden"]):not([type="password"]):not([type="email"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea',
      ),
    ).filter((input) => isShown(input) && !input.disabled)
    const answer = inputs.some(
      (input) =>
        hasCaptchaHint(input) ||
        Array.from(input.labels ?? []).some((label) =>
          CAPTCHA_HINT.test(label.textContent ?? ""),
        ) ||
        IMAGE_INSTRUCTION.test(
          input.getAttribute("aria-label") ??
            input.getAttribute("placeholder") ??
            "",
        ),
    )
    if (
      surfaces.length &&
      ((visualHint && answer) ||
        (instruction &&
          inputs.length &&
          (answer || /captcha|图形验证码|图片验证码|圖片驗證碼/i.test(text))))
    ) {
      return { provider: "image", isPending: () => isShown(scope) }
    }
    if (
      surfaces.length &&
      instruction &&
      (/captcha|verif|human|security|人机|人機|验证|驗證/i.test(text) ||
        /(?:select|click).{0,70}(?:matching|in order|shown above)|(?:drag|slide).{0,60}puzzle|rotate.{0,40}(?:upright|correct)|按.{0,8}(?:顺序|順序)|拼图|拼圖/i.test(
          text,
        )) &&
      Array.from(
        scope.querySelectorAll(
          '[role="slider"], input[type="range"], [tabindex], [draggable="true"], button',
        ),
      ).some(isShown)
    ) {
      return { provider: "interactive", isPending: () => isShown(scope) }
    }
  }
  return undefined
}

/** Only visible, interactive vendor widgets can require user intervention. */
function shownVendorWidgets(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector)).filter(
    (element) =>
      isShown(element) &&
      !element.closest('.grecaptcha-badge, [data-size="invisible"]') &&
      !/[?&]size=invisible\b/i.test(element.getAttribute("src") ?? ""),
  )
}

/** Remember visible vendor UI so unrelated, unchanged widgets are not attributed to a click. */
export function capturePageVerificationWidgets(): ReadonlySet<Element> {
  return new Set(WIDGETS.flatMap((widget) => shownVendorWidgets(widget.widget)))
}

/** Accept tokens only from an unambiguous container of the active widgets. */
function hasActiveWidgetResponse(
  widget: (typeof WIDGETS)[number],
  activeWidgets: Element[],
): boolean {
  return activeWidgets.some((element) => {
    for (
      let scope: Element | null = element;
      scope && scope !== document.body && scope !== document.documentElement;
      scope = scope.parentElement
    ) {
      const fields = Array.from(
        scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          widget.response,
        ),
      )
      if (!fields.length) continue
      const containedWidgets = Array.from(scope.querySelectorAll(widget.widget))
      if (scope.matches(widget.widget)) containedWidgets.push(scope)
      return (
        containedWidgets.every((candidate) =>
          activeWidgets.includes(candidate),
        ) && fields.some((field) => !!field.value?.trim())
      )
    }
    return false
  })
}

/** Prefer explicit widget evidence, then recognize unfamiliar verification UI. */
function observeVerification(
  existingWidgets?: ReadonlySet<Element>,
): ObservedVerification | undefined {
  const widget = WIDGETS.find((candidate) =>
    shownVendorWidgets(candidate.widget).some(
      (element) => !existingWidgets?.has(element),
    ),
  )
  if (widget) {
    const activeWidgets = shownVendorWidgets(widget.widget).filter(
      (element) => !existingWidgets?.has(element),
    )
    return {
      provider: widget.provider,
      fingerprint: activeWidgets,
      isPending: () =>
        !hasActiveWidgetResponse(widget, activeWidgets) &&
        activeWidgets.some(isShown),
    }
  }

  // Recognizable interactive captcha containers must also have a rendered
  // challenge surface; an empty/loading/error container is insufficient.
  for (const panel of document.querySelectorAll(
    ".captcha-panel, .geetest_panel, .geetest_holder",
  )) {
    if (!isShown(panel)) continue
    const surface = Array.from(
      panel.querySelectorAll("img, canvas, .gc-picture"),
    ).find((element) => hasChallengeSurface(element))
    if (surface)
      return {
        provider: "interactive",
        isPending: () => isShown(panel),
      }
  }

  // Require both the challenge image and its answer field in the same UI.
  // A loaded script, dialog title or error message alone is not evidence.
  for (const scope of document.querySelectorAll(
    '[role="dialog"], dialog, form, [class*="captcha"], [id*="captcha"]',
  )) {
    if (!isShown(scope)) continue
    const images = () =>
      Array.from(scope.querySelectorAll("img")).filter(
        (element) => isShown(element) && hasCaptchaHint(element),
      )
    const inputs = () =>
      Array.from(
        scope.querySelectorAll(
          'input:not([type="hidden"]):not([type="password"]), textarea',
        ),
      ).filter((element) => isShown(element) && hasCaptchaHint(element))
    if (images().length && inputs().length)
      return {
        provider: "image",
        // Typing is not verification. Let the native page submit the answer.
        isPending: () =>
          isShown(scope) && !!(images().length || inputs().length),
      }
  }
  return (
    observeGenericVerification() ?? observeExtendedVerification(existingWidgets)
  )
}

/** Whether the current native page exposes verification that must not be bypassed. */
/**
 * Whether verification other than the Turnstile widget itself is still pending.
 *
 * Some deployments ask for a picture code or a slider *before* rendering
 * Turnstile, so a token wait that only watched the widget would sit idle until
 * it timed out without ever inviting the user to finish the first layer.
 */
export function hasOtherPendingVerification(): boolean {
  const observed = observeVerification()
  if (!observed || observed.provider === "turnstile") return false
  return observed.isPending()
}

/**
 * Reports whether the page currently shows any verification challenge.
 *
 * Decides whether an API result can be trusted or the user has to finish the
 * check first; it never interacts with the page itself.
 */
export function hasPageVerification(): boolean {
  return Boolean(observeVerification())
}

/** Observes native-page verification; the page owns submission and token use. */
export async function waitForPageVerification(params: {
  requestId?: string
  existingWidgets?: ReadonlySet<Element>
  requestAssist: () => Promise<unknown> | unknown
}): Promise<PageVerificationResult> {
  const completedScopes = new Set<Element>(params.existingWidgets ?? [])
  const layers: PageVerificationProvider[] = []

  let observed = await waitForAppearance(APPEARANCE_WAIT_MS, completedScopes)
  while (observed && layers.length < MAX_VERIFICATION_LAYERS) {
    const provider = observed.provider
    const outcome = await waitForLayerOutcome(observed, {
      requestId: params.requestId,
      requestAssist: params.requestAssist,
    })
    layers.push(provider)

    if (outcome === "required") {
      return {
        status: "required",
        provider,
        ...(layers.length > 1 ? { layers } : {}),
      }
    }

    // Remember exactly what finished, so a widget that stays on screen is not
    // read as the page asking the same thing again.
    for (const element of observed.fingerprint ?? []) {
      completedScopes.add(element)
    }

    // A chained layer is normally rendered by the page as this one resolves, so
    // look once without waiting: a finished check-in must report immediately.
    // A leftover widget the site already answered is not a new layer.
    const nextLayer = observeVerification(completedScopes)
    observed = nextLayer?.isPending() ? nextLayer : undefined
  }

  if (!layers.length) return { status: "not_present" }
  const lastProvider = layers[layers.length - 1]
  if (!lastProvider) return { status: "not_present" }
  // A single layer keeps the original shape; `layers` only appears when the page
  // really chained verifications, so consumers can tell the two cases apart.
  return {
    status: "completed",
    provider: lastProvider,
    ...(layers.length > 1 ? { layers } : {}),
  }
}

/** Wait for verification UI to render, ignoring what earlier layers already used. */
async function waitForAppearance(
  timeoutMs: number,
  completedScopes: ReadonlySet<Element>,
): Promise<ObservedVerification | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const observed = observeVerification(completedScopes)
    if (observed) return observed
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/**
 * Watch one verification layer until it is done or needs the user.
 *
 * Disappearance is only a cue to read back status, never proof of success: the
 * caller always confirms the award with a status read.
 */
async function waitForLayerOutcome(
  observed: ObservedVerification,
  params: {
    requestId?: string
    requestAssist: () => Promise<unknown> | unknown
  },
): Promise<"completed" | "required"> {
  const autoDeadline = Date.now() + TURNSTILE_AUTO_ASSIST_MS
  let deadline = autoDeadline
  let assistPendingUntil = 0
  let assistRequested = false
  const manualWindow = createVerificationManualWindow(params.requestId)

  try {
    // A real timer can wake after the automatic deadline; still admit the one
    // assist attempt before deciding that the wait has expired.
    while (
      !assistRequested ||
      Date.now() <=
        Math.max(deadline, assistPendingUntil, manualWindow.getDeadline())
    ) {
      if (!observed.isPending()) return "completed"

      if (!assistRequested && Date.now() >= autoDeadline) {
        assistRequested = true
        assistPendingUntil = Date.now() + TURNSTILE_ASSIST_TURN_WAIT_MS
        void Promise.resolve()
          .then(() => params.requestAssist())
          .then(
            (accepted) => accepted !== false,
            () => false,
          )
          .then((accepted) => {
            assistPendingUntil = 0
            if (accepted) deadline = Date.now() + TURNSTILE_MANUAL_WAIT_MS
          })
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    return "required"
  } finally {
    manualWindow.dispose()
  }
}
