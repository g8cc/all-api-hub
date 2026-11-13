import { queryAllDeep } from "~/services/checkin/pageVerification"

import {
  normalizeTurnstileSitekey,
  normalizeTurnstileWidgetParam,
} from "./solverContracts"

/**
 * Reads the Turnstile site key of the widget a page intends to render.
 *
 * The solving service needs the pair (page URL, site key) and nothing else: the
 * site key is public by design and ships in the page. The secret key belongs to
 * the site's backend and is never read here, so the scan is limited to places a
 * browser would legitimately see a public key.
 */

/** Attributes that carry a public site key on a widget container. */
const SITEKEY_ATTRIBUTE_NAMES = [
  "data-sitekey",
  "data-turnstile-sitekey",
  "turnstile-sitekey",
  "data-wgt-sitekey",
  "sitekey",
] as const

/**
 * Attribute names whose spelling already says Turnstile, so the container needs
 * no further evidence.
 */
const TURNSTILE_ATTRIBUTE_NAMES = new Set([
  "data-turnstile-sitekey",
  "turnstile-sitekey",
])

/** Markers that say a container is the Turnstile widget rather than some other key. */
const TURNSTILE_MARKER = /turnstile|cf-challenge|cloudflare/i

/** Where a page says it loads Turnstile at all. */
const TURNSTILE_SCRIPT_SOURCE =
  /challenges\.cloudflare\.com\/.*turnstile|\/turnstile\.js/i

/**
 * Whether the page loads the Turnstile bundle.
 *
 * A key found on a plainly marked element only counts as a site key once the
 * page shows it really renders that widget; otherwise a different captcha
 * family's key would be sent to a Turnstile solver and spend credit on a
 * request the service can only reject.
 */
function pageLoadsTurnstile(): boolean {
  const scripts = [
    ...document.querySelectorAll("script[src]"),
    ...queryAllDeep("script[src]"),
  ]
  if (
    scripts.some((script) =>
      TURNSTILE_SCRIPT_SOURCE.test(script.getAttribute("src") ?? ""),
    )
  ) {
    return true
  }

  return readSitekeyFromFrame() !== null
}

/** Whether an element is marked as the Turnstile widget itself. */
function isTurnstileContainer(element: Element): boolean {
  const identity = `${element.id ?? ""} ${element.className ?? ""} ${
    element.tagName ?? ""
  } ${element.closest?.("[id],[class]")?.id ?? ""} ${
    element.closest?.("[id],[class]")?.className ?? ""
  }`
  return TURNSTILE_MARKER.test(identity)
}

/** Matches a public site key inside an inline `render({ sitekey: "..." })` call. */
const INLINE_SITEKEY_PATTERN =
  /sitekey\s*[:=]\s*["']([A-Za-z0-9_-]{10,64})["']/gi

/** A secret key is named as such; it must never be sent anywhere. */
const SECRET_KEY_NAME = /secret|private|server/i

/** Reads candidate values from attributes of Turnstile-looking containers. */
function readSitekeyFromAttributes(): string | null {
  const selectors = [
    ".cf-turnstile",
    "[data-sitekey]",
    "[data-turnstile-sitekey]",
    "[turnstile-sitekey]",
    "[id*='turnstile' i]",
    "[class*='turnstile' i]",
  ]
  const seen = new Set<string>()

  for (const selector of selectors) {
    let elements: Element[]
    try {
      elements = [
        ...document.querySelectorAll(selector),
        ...queryAllDeep(selector),
      ]
    } catch {
      continue
    }

    for (const element of elements) {
      const host = element.closest?.("[data-sitekey]") ?? element
      for (const container of [element, host]) {
        for (const name of SITEKEY_ATTRIBUTE_NAMES) {
          const raw = container.getAttribute?.(name)
          if (!raw) continue
          // A container that carries no Turnstile marker only counts when the
          // page demonstrably loads the widget.
          if (
            !TURNSTILE_ATTRIBUTE_NAMES.has(name) &&
            !isTurnstileContainer(container) &&
            !pageLoadsTurnstile()
          ) {
            continue
          }
          // A key that only appears on an element naming a secret is not public.
          const identity = `${container.id ?? ""} ${container.className ?? ""} ${
            container.tagName ?? ""
          }`
          if (
            name === "sitekey" &&
            SECRET_KEY_NAME.test(identity) &&
            !TURNSTILE_MARKER.test(identity)
          ) {
            continue
          }
          const sitekey = normalizeTurnstileSitekey(raw)
          if (!sitekey || seen.has(sitekey)) continue
          seen.add(sitekey)
          return sitekey
        }
      }
    }
  }

  return null
}

/** Reads the site key from a rendered widget iframe or its API anchor. */
function readSitekeyFromFrame(): string | null {
  const frames = [
    ...document.querySelectorAll("iframe"),
    ...queryAllDeep("iframe"),
  ]

  for (const frame of frames) {
    const src = frame.getAttribute("src") ?? ""
    if (!/challenges\.cloudflare\.com|turnstile/i.test(src)) continue

    for (const name of ["sitekey", "render", "skey"]) {
      const query = new RegExp(`[?&]${name}=([^&#]*)`, "i").exec(src)
      if (!query?.[1]) continue
      let decoded = query[1]
      try {
        decoded = decodeURIComponent(query[1])
      } catch {
        /* Keep the raw value when it is not percent-encoded. */
      }
      const sitekey = normalizeTurnstileSitekey(decoded)
      if (sitekey) return sitekey
    }
  }

  return null
}

/**
 * Reads a site key from inline script text.
 *
 * Many deployments call `turnstile.render()` from an inline script, so the key
 * never lands on an element. Only the public spelling is matched, and a
 * candidate from a line naming a secret is skipped.
 */
function readSitekeyFromInlineScripts(): string | null {
  const scripts = [
    ...document.querySelectorAll("script"),
    ...queryAllDeep("script"),
  ]

  for (const script of scripts) {
    const text = script.textContent ?? ""
    if (!text || text.length > 200_000) continue
    if (!/sitekey/i.test(text)) continue

    INLINE_SITEKEY_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = INLINE_SITEKEY_PATTERN.exec(text))) {
      const line = text.slice(
        Math.max(0, (match.index ?? 0) - 120),
        (match.index ?? 0) + 200,
      )
      if (SECRET_KEY_NAME.test(line) && !TURNSTILE_MARKER.test(line)) continue
      const sitekey = normalizeTurnstileSitekey(match[1])
      if (sitekey) return sitekey
    }
  }

  return null
}

/** Optional widget parameters a deployment can bind a token to. */
const WIDGET_PARAMETER_NAMES = {
  action: "data-action",
  cdata: "data-cdata",
} as const

/** Service-side length limits for the optional widget parameters. */
const WIDGET_PARAMETER_LIMITS = { action: 32, cdata: 255 } as const

/** Reads `action` / `cdata` from the container that carried the site key. */
function readWidgetParameters(): {
  action: string | null
  cdata: string | null
} {
  const containers = [
    ...document.querySelectorAll(
      ".cf-turnstile, [data-sitekey], [data-turnstile-sitekey]",
    ),
    ...queryAllDeep(".cf-turnstile, [data-sitekey], [data-turnstile-sitekey]"),
  ]

  for (const container of containers) {
    const action = normalizeTurnstileWidgetParam(
      container.getAttribute(WIDGET_PARAMETER_NAMES.action),
      WIDGET_PARAMETER_LIMITS.action,
    )
    const cdata = normalizeTurnstileWidgetParam(
      container.getAttribute(WIDGET_PARAMETER_NAMES.cdata),
      WIDGET_PARAMETER_LIMITS.cdata,
    )
    if (action || cdata) return { action, cdata }
  }

  return { action: null, cdata: null }
}

/**
 * Everything the solving service needs about the widget this page would render.
 *
 * A deployment that binds the token to an `action` rejects an unbound one, so
 * the parameters travel with the site key whenever the page declares them.
 */
export function extractTurnstileWidgetParams(): {
  sitekey: string | null
  action: string | null
  cdata: string | null
} {
  const sitekey =
    readSitekeyFromAttributes() ??
    readSitekeyFromFrame() ??
    readSitekeyFromInlineScripts()

  if (!sitekey) return { sitekey: null, action: null, cdata: null }
  return { sitekey, ...readWidgetParameters() }
}

/**
 * Best-effort site key for the widget this page would render, or `null` when the
 * page shows no Turnstile evidence at all.
 */
export function extractTurnstileSitekey(): string | null {
  return extractTurnstileWidgetParams().sitekey
}
