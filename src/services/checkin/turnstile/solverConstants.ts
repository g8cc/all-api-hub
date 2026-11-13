/**
 * Defaults for the optional Turnstile solving service.
 *
 * This is the only file that names the service. Everything else reads the
 * values through preferences, so the endpoint and the credential live in one
 * place and can be replaced or emptied here without touching the check-in
 * code.
 */

/** Solver gateway base URL; `POST /solve` is appended to it. */
export const TURNSTILE_SOLVER_DEFAULT_ENDPOINT = "https://solver.000.moe"

/**
 * Credential used as `Authorization: Bearer <key>`, empty by default.
 *
 * A solving credential spends money and identifies its holder, so the
 * repository never carries one. Two ways to supply it:
 *
 * - the settings page 设置 → 数据刷新 → 网站验证辅助 → Turnstile 自动通过, which
 *   stores it in this browser profile's local preferences;
 * - `VITE_TURNSTILE_SOLVER_API_KEY` in the git-ignored `.env.local`, which bakes
 *   it into a local development build.
 *
 * With no credential the service is off and the built-in page and manual paths
 * are the only ones used.
 */
/**
 * Optional chaining is deliberate: Playwright loads specs straight from source,
 * where no bundler has defined `import.meta.env`, and this module is reached
 * through the check-in chain. A bare read would throw during E2E collection and
 * take every shard down with it, exactly as `getRuntimeMode` already guards.
 */
export const TURNSTILE_SOLVER_DEFAULT_API_KEY: string = String(
  import.meta.env?.VITE_TURNSTILE_SOLVER_API_KEY ?? "",
).trim()

/** Budget for one solve request; the service renders the widget server-side. */
export const TURNSTILE_SOLVER_DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long to look for a site key in the page before concluding the solver
 * cannot be used. The widget is usually already in the markup, so this only
 * covers a late render.
 */
export const TURNSTILE_SOLVER_SITEKEY_WAIT_MS = 2_500

/** Poll gap while scanning for a site key. */
export const TURNSTILE_SOLVER_SITEKEY_POLL_MS = 250

/**
 * Whether to call the service before or after letting the page solve itself.
 *
 * - `api_before_page`: no window is shown for Turnstile-only sites; the page
 *   wait and the manual reminder still run if the service cannot help.
 * - `page_before_api`: the page gets its normal quiet attempt first, so an
 *   invisible widget that passes for free never costs a service request.
 */
export const TURNSTILE_SOLVER_MODES = {
  ApiBeforePage: "api_before_page",
  PageBeforeApi: "page_before_api",
} as const

export type TurnstileSolverMode =
  (typeof TURNSTILE_SOLVER_MODES)[keyof typeof TURNSTILE_SOLVER_MODES]

export const DEFAULT_TURNSTILE_SOLVER_MODE: TurnstileSolverMode =
  TURNSTILE_SOLVER_MODES.ApiBeforePage
