# Published vs local source (the one-release lag)

Moved verbatim out of `CLAUDE.md`. Read this when you change anything in `packages/tooling/**`, when a
validator rejects a config key, when a guard or executor does not seem to see your change, or when you
are working in a linked worktree.

### Published vs local source (the one-release lag)

This repo **dogfoods the published `@webpieces/*` packages**. `node_modules/@webpieces/*` are real
published copies (verified: real directories, not symlinks into local `dist/`), and they are always
**one release behind** the local source in `packages/tooling/**` — published `0.4.x` vs a local
`0.0.0-dev`.

TypeScript and vitest do NOT see it that way. `tsconfig.base.json` maps `@webpieces/*` to
`packages/tooling/**/src/index.ts`, so type-checking and unit tests exercise your **local** changes.
Almost everything else runs the **published** copy:

| Runs the PUBLISHED copy | Consequence |
|---|---|
| nx executors (`architecture:generate`, `di-graph-generate`, `validate-*-unchanged`) | local `nx-webpieces-rules` changes are invisible to `pnpm arch:generate` and to the build's `validate-*-unchanged` gates |
| `wp-*` bins (`wp-ci`, `wp-start-upsert-pr`, `wp-review-upsert-pr`, `wp-finish-upsert-pr`, `wp-cleanup`) | running one is **not** an end-to-end test of unreleased `pr-gate` / `code-rules` changes |
| PreToolUse hooks (`wp-ai-rules-hook`, `wp-ai-guards-hook`) | guard changes take effect only after publish + `pnpm install` |
| the ESLint `@webpieces` plugin | a rule named in the live config before publish fails the graph load |

**What this means in practice:**

- **Verify plugin/rule changes with the package's own vitest suite** (tsconfig paths → local src), NOT
  by regenerating artifacts. Regenerated `architecture/*`, `design.json` and `design.html` have to wait
  until after publish.
- **Do not add a new `webpieces.config.json` key in the same PR that adds the rule.** The published
  validator does not know the key, rejects it as an unknown rule, and that blocks every Bash/Edit —
  a deadlocked session. Ship the source, publish, then a follow-up PR adds the live config entry.
- **A green build does not prove your plugin change took effect.** If
  `validate-architecture-unchanged` stays green after you changed graph-producing code, the likely
  reason is that the executors ran the OLD published plugin — not that your change was a no-op. Look at
  `node_modules/@webpieces/<pkg>` before concluding anything.
- If a validator rejects a config key as UNKNOWN, **delete the key** — that is the primary cure, and
  `pnpm wp-prune-unknown-config` does it mechanically. A key no running validator has a schema for
  controls nothing, and for a RETIRED key deletion is the whole fix. The stale-validator case (the key is
  valid, your pin is behind) never reaches that message: the version-drift guard catches it first and
  prescribes its own cure, so `pnpm install` is not the answer to a validation error.

**A linked worktree does not get its own RELEASE — there is ONE governor per repo.** `git worktree add`
copies no `node_modules`, so until something installs there a worktree resolves `@webpieces/*` by walking
up to the MAIN tree's install and runs the MAIN tree's binary.

**That is about the RELEASE, not about `node_modules`.** A worktree may perfectly well have its own —
nx, vitest and the eslint plugin all execute in that tree and load from it, and `pnpm add <anything>`
creates one as a matter of course. Installing in a worktree is fine. The one invariant is that its
`@webpieces` version must **EQUAL** the main tree's, and when it does not the guards **BLOCK**
(`trinary-version-skew`) rather than silently governing the tree with a release it never pinned. The pin
is TRACKED, so the same git hash gives the same pin — `git pull` both trees onto the same main, then
`pnpm install` in each tree that has a `node_modules`, or just work in the main tree. A separate CLONE is
the answer to "I genuinely need a DIFFERENT version" — never to "I need to install here".
