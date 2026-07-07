# AI Agent Instructions: `process.exit()` Outside `main()` Detected

**READ THIS FILE to understand why a deep `process.exit` is banned and how to fix the violation.**

The rule `no-process-exit-outside-main` flagged a `process.exit(...)` that is NOT inside a `main()` /
`runMain` wrapper (or an `import { main }` from another module). Fix it by moving the exit to the top.

## Why this rule exists

**Any code may be reused.** A function that calls `process.exit()` (or `System.exit()`) can be
imported and called from a server, a CLI, a test, or another library. When it exits, it kills the
**entire host process** — far too early and completely unexpectedly to the caller.

This is not hypothetical: `git-gatherInfo`'s `main()` was imported as a library by `merge-start` and
called `process.exit(0)` when the branch was already up to date. That silently killed the parent
command (`wp-start-upsert-pr`) **before it pushed or built** — and because the code was `0`, it looked
like **success**. A deep exit with code 0 masquerades as success; a deep exit with any code is an
unexpected crash of whatever reused the code.

## The rule: throw a semantic error — never exit deep in the stack

Deep code must **throw**, not exit. Which error you throw is **app-dependent** (server vs command-line
vs library) — throw what fits the domain. Two flavors:

1. **Expected / normal failure** — the operation legitimately failed and you want to report it. Throw
   your domain's failure type.
   - In this **rules engine**: `throw new RuleFailError(ruleName, message, ...)`.
2. **A bug / broken precondition** — a should-never-happen situation: a required variable is missing,
   an index is out of bounds, an invariant was violated. Throw an ordinary bug-signaling `Error`
   (the `IndexOutOfBounds` analog) — it means "the library has a bug", not "the user did something wrong".

Do **not** invent a single generic exit-everywhere helper. Throw the error that matches the situation
and let the top decide the process's fate.

## The one exit site: `main()` / server bootstrap

Exactly one place may end the process: the top-level entry — `main()` for a command, or the server
bootstrap. It has ONE `try/catch` that catches everything thrown from below, prints it, and picks the
exit code: **non-zero (e.g. `2`) on failure, `0` on success.**

In this repo that wrapper is `runMain` (from `@webpieces/rules-config`). Every bin is:

```ts
export async function main(): Promise<void> {
    // ... do the work; deep code THROWS on failure, never exits ...
}

if (require.main === module) runMain(main);   // the ONLY process.exit lives inside runMain
```

Need a **specific** exit code from deep in the stack? Throw `CliExitError(code, message)` (from
`@webpieces/rules-config`) — `runMain` reads its `.exitCode`. Everything else exits non-zero.

A server bootstrap is the same shape: one top-level `try/catch` that logs and exits on a startup error.

## Do not import another module's `main`

`main` is a bin entry point, not a library export. Importing it (`import { main } from '...'`, incl.
`import { main as X }`) is exactly what lets library code call an *exiting* `main` and kill the parent.
Export and call a **named function**; only a thin wrapper calls `main`.

## How to fix the flagged line

- **A helper that exits on failure** → make it `throw` (a `RuleFailError`, a bug `Error`, or
  `CliExitError(code, msg)` if you need a specific code). The caller's `main`/`runMain` will exit.
- **A bin file's launcher** → wrap it: `if (require.main === module) runMain(main);` and remove the
  bare `process.exit`.
- **A genuine terminal boundary** (a real `main()`/`runMain`, or a server bootstrap's startup catch)
  → that is where exit belongs; the rule already allows `main`/`runMain`. For a boundary the heuristic
  can't see, append (when `disableAllowed: true`):
  `// webpieces-disable no-process-exit-outside-main -- <reason>`

## Rolling out gradually

This is a config-driven webpieces rule (`webpieces.config.json` → `no-process-exit-outside-main`) with
the standard knobs: `mode` (`OFF` | `NEW_AND_MODIFIED_CODE` | `NEW_AND_MODIFIED_FILES`),
`ignoreModifiedUntilEpoch`, `ignoreRuleWhileOnBranch`, and `disableAllowed`. Start narrow
(`NEW_AND_MODIFIED_FILES`, `disableAllowed: true`) and fix the codebase slowly — only new/modified code
is flagged.
