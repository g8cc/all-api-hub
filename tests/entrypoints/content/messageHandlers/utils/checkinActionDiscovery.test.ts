import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  triggerCheckinPageAction,
  waitForCheckinPageActionTarget,
} from "~/entrypoints/content/messageHandlers/utils/turnstileGuard"
import { TURNSTILE_PRE_TRIGGER_KINDS } from "~/types/turnstile"

/**
 * Deployments style their check-in action differently: a semantic button, an
 * anchor, a `div` with an onclick handler, an icon-only button whose label lives
 * in `aria-label`, or a control rendered inside a web component. All of them
 * must be found, and a completed ("already checked in") control must still be
 * skipped.
 */

const CHECKIN_BUTTON_TRIGGER = {
  kind: TURNSTILE_PRE_TRIGGER_KINDS.CheckinButton,
} as const

describe("check-in action discovery", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    globalThis.__aahTurnstilePreTriggerState = undefined
    globalThis.__aahTurnstileAutoStartState = undefined
    vi.restoreAllMocks()
  })

  it("clicks a plain semantic button", () => {
    document.body.innerHTML = '<button id="go">每日签到</button>'
    const button = document.getElementById("go")!
    const clicked = vi.fn()
    button.addEventListener("click", clicked)

    const result = triggerCheckinPageAction({
      requestId: "req-button",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("clicked")
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it("clicks a styled div whose label is a nested span", () => {
    document.body.innerHTML = `
      <div class="card">
        <div class="action-btn"><span>点击签到</span></div>
      </div>`
    const action = document.querySelector(".action-btn")!
    const clicked = vi.fn()
    action.addEventListener("click", clicked)

    const result = triggerCheckinPageAction({
      requestId: "req-div",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("clicked")
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(result.target?.tagName).toBe("div")
  })

  it("clicks an icon-only button whose label is aria-label", () => {
    document.body.innerHTML =
      '<button id="icon" aria-label="立即签到"><svg></svg></button>'
    const button = document.getElementById("icon")!
    const clicked = vi.fn()
    button.addEventListener("click", clicked)

    const result = triggerCheckinPageAction({
      requestId: "req-aria",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("clicked")
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it("prefers the control over the card that wraps it", () => {
    // The wrapper contains the same words, so a whole-card match would click the
    // wrong element and never run the site's handler.
    document.body.innerHTML = `
      <div class="checkin-card">
        每日签到领取额度
        <button id="real">签到</button>
      </div>`
    const button = document.getElementById("real")!
    const clicked = vi.fn()
    button.addEventListener("click", clicked)

    const result = triggerCheckinPageAction({
      requestId: "req-prefer",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("clicked")
    expect(result.target?.text).toBe("签到")
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it("skips a disabled action and reports that no target is clickable", () => {
    document.body.innerHTML =
      '<button id="off" disabled>签到</button><button id="on" aria-disabled="true">签到</button>'

    const result = triggerCheckinPageAction({
      requestId: "req-disabled",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("target_not_found")
    expect(result.reason).toBe("noTarget")
  })

  it("still skips an already-completed control", () => {
    document.body.innerHTML = '<button id="done">今日已签到</button>'

    const result = triggerCheckinPageAction({
      requestId: "req-done",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("target_not_found")
  })

  it("finds an action rendered inside an open shadow root", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: "open" })
    shadow.innerHTML = '<button id="inner">签到</button>'
    const inner = shadow.getElementById("inner")!
    const clicked = vi.fn()
    inner.addEventListener("click", clicked)

    const result = triggerCheckinPageAction({
      requestId: "req-shadow",
      trigger: CHECKIN_BUTTON_TRIGGER,
    })

    expect(result.status).toBe("clicked")
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it("waits for a late-rendered action before clicking", async () => {
    document.body.innerHTML = "<div id='mount'></div>"
    setTimeout(() => {
      const mount = document.getElementById("mount")
      if (mount) mount.innerHTML = '<button id="late">签到</button>'
    }, 200)

    await waitForCheckinPageActionTarget({
      kind: TURNSTILE_PRE_TRIGGER_KINDS.ClickText,
      positivePattern: "签到",
      targetWaitMs: 2_000,
    })

    const result = triggerCheckinPageAction({
      requestId: "req-late",
      trigger: {
        kind: TURNSTILE_PRE_TRIGGER_KINDS.ClickText,
        positivePattern: "签到",
      },
    })

    expect(result.status).toBe("clicked")
  })
})
