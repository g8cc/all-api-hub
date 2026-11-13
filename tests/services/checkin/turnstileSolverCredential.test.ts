import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The Turnstile solving service is a paid third party, so a real credential must
 * never reach the repository: the shipped default stays empty and comes from the
 * git-ignored local env file. A literal key here would silently enable paid
 * solves for every installed build and spend somebody's balance.
 *
 * These checks read the source rather than the compiled constant, so they hold
 * whether or not this machine happens to define `VITE_TURNSTILE_SOLVER_API_KEY`.
 */
const SOURCE_PATH = resolve(
  process.cwd(),
  "src/services/checkin/turnstile/solverConstants.ts",
)

/** Anything shaped like a long bearer token, independent of a vendor prefix. */
const CREDENTIAL_SHAPED_LITERAL = /["'`][A-Za-z0-9_-]{32,}["'`]/

/** The single `export const` block that declares the shipped key default. */
const solverKeyDeclaration = () => {
  const source = readFileSync(SOURCE_PATH, "utf8")
  const blocks = source.split("\nexport const ").slice(1)
  const block = blocks.find((entry) =>
    entry.startsWith("TURNSTILE_SOLVER_DEFAULT_API_KEY"),
  )

  expect(block, "the solver key default must stay declared").toBeDefined()

  return String(block)
}

describe("Turnstile solver credential source", () => {
  it("takes the API key from the build environment only", () => {
    expect(solverKeyDeclaration()).toContain(
      "import.meta.env.VITE_TURNSTILE_SOLVER_API_KEY",
    )
  })

  it("carries no credential-shaped literal", () => {
    expect(solverKeyDeclaration()).not.toMatch(CREDENTIAL_SHAPED_LITERAL)
  })
})
