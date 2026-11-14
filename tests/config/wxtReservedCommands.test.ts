import { describe, expect, it } from "vitest"
import type { ConfigEnv } from "wxt"

import wxtConfig from "~~/wxt.config"

/**
 * Reserved `commands` names are validated per browser, and an unknown name is
 * dropped with a manifest warning that chrome://extensions shows on every load.
 * The Chromium build shipped `_execute_browser_action` (the Manifest V2 name for
 * the action shortcut) together with `_execute_sidebar_action` (Firefox only), so
 * Chrome reported both as unusable and no shortcut could be assigned there.
 * Firefox is built as Manifest V2 by this repository, where those two names are
 * the correct ones, so only the Chromium family changes.
 */
async function commandsFor(browser: string) {
  if (typeof wxtConfig.manifest !== "function") {
    throw new Error("Expected a manifest factory")
  }
  const manifest = await wxtConfig.manifest({
    command: "build",
    browser,
    manifestVersion: browser === "firefox" || browser === "safari" ? 2 : 3,
    mode: "production",
  } as unknown as ConfigEnv)

  return manifest.commands as Record<string, { description?: string }>
}

describe("manifest reserved commands", () => {
  it("declares only Manifest V3 names for the Chrome build", async () => {
    const commands = await commandsFor("chrome")

    expect(Object.keys(commands)).toEqual(["_execute_action"])
    expect(commands._execute_action?.description).toBe(
      "__MSG_manifest_commands_browser_action__",
    )
  })

  it("keeps the Firefox sidebar and action shortcuts", async () => {
    const commands = await commandsFor("firefox")

    expect(Object.keys(commands).sort()).toEqual([
      "_execute_browser_action",
      "_execute_sidebar_action",
    ])
  })

  it("does not leak the Firefox-only sidebar name into other targets", async () => {
    for (const browser of ["chrome", "safari"]) {
      const commands = await commandsFor(browser)

      expect(commands).not.toHaveProperty("_execute_sidebar_action")
      expect(commands).not.toHaveProperty("_execute_browser_action")
    }
  })
})
