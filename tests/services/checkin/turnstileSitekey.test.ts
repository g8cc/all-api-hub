import { beforeEach, describe, expect, it } from "vitest"

import {
  extractTurnstileSitekey,
  extractTurnstileWidgetParams,
} from "~/services/checkin/turnstile/sitekey"

/**
 * The site key is public by design, but it appears in more places than one, and
 * a wrong pick (the secret key, or some other integration's key) would either
 * fail the solve or leak something it should not.
 */
describe("Turnstile site key discovery", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("returns nothing for a page with no widget", () => {
    document.body.innerHTML = `<button>签到</button><input name="email" />`
    expect(extractTurnstileSitekey()).toBeNull()
  })

  it("reads the key from the widget container", () => {
    document.body.innerHTML = `<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-container-key"></div>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-container-key")
  })

  it("reads the key from an invisible container attribute", () => {
    document.body.innerHTML = `<div data-turnstile-sitekey="0x4AAAAAAA-attribute-key"></div>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-attribute-key")
  })

  it("reads the key from the rendered challenge frame", () => {
    document.body.innerHTML = `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/ov0/ab123/auto/fb0?sitekey=0x4AAAAAAA-frame-key&appearance=bright"></iframe>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-frame-key")
  })

  it("reads the key from a programmatic render call", () => {
    document.body.innerHTML = `<script>
      window.turnstile.render("#widget", {
        sitekey: "0x4AAAAAAA-inline-key",
        callback: window.submit,
      })
    </script>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-inline-key")
  })

  it("reads the key from inside an open shadow root", () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = host.attachShadow({ mode: "open" })
    const widget = document.createElement("div")
    widget.className = "cf-turnstile"
    widget.setAttribute("data-sitekey", "0x4AAAAAAA-shadow-key")
    root.append(widget)

    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-shadow-key")
  })

  it("ignores a key that sits on a server secret holder", () => {
    document.body.innerHTML = `<input type="hidden" id="secret_sitekey" name="secret_sitekey" sitekey="0xSECRETneverused0" />`
    expect(extractTurnstileSitekey()).toBeNull()
  })

  it("ignores a key that is not a site key shape", () => {
    document.body.innerHTML = `<div class="cf-turnstile" data-sitekey="short"></div>`
    expect(extractTurnstileSitekey()).toBeNull()
  })

  it("prefers the Turnstile widget over an unrelated data-sitekey on the page", () => {
    document.body.innerHTML = `
      <div data-sitekey="0x4AAAAAAAAAAAAAAAcaptcha"></div>
      <div class="cf-turnstile" data-sitekey="0x4AAAAAAAAAAAAAAAturnstile"></div>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAAAAAAAAAAturnstile")
  })

  it("reads the parameters the token is bound to", () => {
    document.body.innerHTML = `<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-site-key" data-action="daily_checkin" data-cdata="account-7"></div>`
    expect(extractTurnstileWidgetParams()).toEqual({
      sitekey: "0x4AAAAAAA-site-key",
      action: "daily_checkin",
      cdata: "account-7",
    })
  })

  it("reports no parameters when the widget carries none", () => {
    document.body.innerHTML = `<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-site-key"></div>`
    expect(extractTurnstileWidgetParams()).toEqual({
      sitekey: "0x4AAAAAAA-site-key",
      action: null,
      cdata: null,
    })
  })

  it("reports nothing when the page has no Turnstile widget to bind to", () => {
    document.body.innerHTML = `<div data-action="login" data-cdata="x"></div>`
    expect(extractTurnstileWidgetParams()).toEqual({
      sitekey: null,
      action: null,
      cdata: null,
    })
  })

  it("does not mistake another widget family for Turnstile", () => {
    // A page can host several captcha families at once; the solver must only
    // ever see the Turnstile key.
    document.body.innerHTML = `
      <div class="geetest_captcha" data-sitekey="0x4GEETESTFAMILYKEY"></div>
      <div class="cf-turnstile" data-sitekey="0x4AAAAAAA-real-turnstile"></div>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-real-turnstile")

    document.body.innerHTML = `<div class="geetest_captcha" data-sitekey="0x4GEETESTFAMILYKEY"></div>`
    expect(extractTurnstileSitekey()).toBeNull()
  })

  it("reports the credential without any markup or surrounding text", () => {
    document.body.innerHTML = `<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-site-key"><span>请完成验证</span></div>`
    expect(extractTurnstileSitekey()).toBe("0x4AAAAAAA-site-key")
  })
})
