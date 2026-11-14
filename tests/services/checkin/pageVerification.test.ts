import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  hasOtherPendingVerification,
  hasPageVerification,
  waitForPageVerification,
} from "~/services/checkin/pageVerification"

/**
 * These cases cover the check-in deployments that were reported as failing:
 * a single Turnstile widget, two chained verification layers, a plain image
 * code with no vendor naming, and a page with no verification at all.
 */

const noAssist = () => false

describe("pageVerification", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    vi.useRealTimers()
  })

  it("reports no verification for an ordinary page", () => {
    document.body.innerHTML = "<main><h1>Console</h1><p>Ready</p></main>"
    expect(hasPageVerification()).toBe(false)
  })

  it("detects a vendor Turnstile widget", () => {
    document.body.innerHTML = `
      <form>
        <div class="cf-turnstile" data-sitekey="site-key"></div>
      </form>`
    expect(hasPageVerification()).toBe(true)
    expect(hasOtherPendingVerification()).toBe(false)
  })

  it("detects an image code whose picture has an opaque file name", () => {
    // The picture is served from a path that does not say "captcha"; only the
    // refresh link and the Chinese instruction identify it.
    document.body.innerHTML = `
      <form id="checkin">
        <label>请输入验证码 <input name="code" maxlength="4" /></label>
        <img src="/api/v1/img/a8f31d" alt="" />
        <a href="javascript:;">换一张</a>
        <button type="submit">签到</button>
      </form>`
    expect(hasPageVerification()).toBe(true)
    expect(hasOtherPendingVerification()).toBe(true)
  })

  it("detects a code picture through its resource name alone", () => {
    document.body.innerHTML = `
      <div class="panel">
        <img src="/api/captcha/generate?t=1" />
        <input name="answer" />
      </div>`
    expect(hasPageVerification()).toBe(true)
  })

  it("detects a slider challenge that has no image and no vendor class", () => {
    document.body.innerHTML = `
      <section>
        <p>请拖动滑块完成验证</p>
        <div draggable="true" role="slider" tabindex="0">拖动到这里</div>
      </section>`
    expect(hasPageVerification()).toBe(true)
  })

  it("ignores an unrelated picture with no instruction and no answer field", () => {
    document.body.innerHTML = `
      <article>
        <h2>公告</h2>
        <img src="/static/banner.png" alt="banner" />
        <p>今日签到奖励已发放</p>
      </article>`
    expect(hasPageVerification()).toBe(false)
  })

  it("waits through two chained layers and reports both in order", async () => {
    // Layer 1: Turnstile. Layer 2 appears only after the first token arrives.
    document.body.innerHTML = `
      <form id="checkin-form">
        <div class="cf-turnstile" data-sitekey="site-key"></div>
        <input type="hidden" name="cf-turnstile-response" value="" />
      </form>`

    const wait = waitForPageVerification({
      requestId: "req-two-layers",
      requestAssist: noAssist,
    })

    // The page reveals its second challenge, then resolves the first one: a
    // chained layer is already on screen when the widget gets its token.
    setTimeout(() => {
      const form = document.getElementById("checkin-form")
      form?.insertAdjacentHTML(
        "beforeend",
        `<div class="modal-captcha">
           <p>请输入验证码</p>
           <img src="/api/code/1" />
           <input name="verifyCode" maxlength="4" />
         </div>`,
      )
    }, 300)
    setTimeout(() => {
      const token = document.querySelector<HTMLInputElement>(
        'input[name="cf-turnstile-response"]',
      )
      if (token) token.value = "token-value"
    }, 600)

    // Complete the second layer, then remove both.
    setTimeout(() => {
      document.querySelector(".modal-captcha")?.remove()
      const first = document.querySelector(".cf-turnstile")
      first?.closest("form")?.querySelector(".cf-turnstile")?.remove()
    }, 1_500)

    const result = await wait

    expect(result.status).toBe("completed")
    expect(result.status === "completed" && result.layers).toEqual([
      "turnstile",
      "image",
    ])
  }, 20_000)

  it("reports required for a verification the user never finishes", async () => {
    document.body.innerHTML = `
      <form>
        <p>请输入验证码</p>
        <img src="/api/code/2" />
        <input name="captcha" maxlength="4" />
      </form>`

    const result = await waitForPageVerification({
      requestId: "req-required",
      requestAssist: noAssist,
    })

    expect(result.status).toBe("required")
    expect(result.status === "required" && result.provider).toBe("image")
  }, 20_000)
})
