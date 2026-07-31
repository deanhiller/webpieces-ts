# BUG: every `pnpm install` emits ~40 lines of ENOENT bin warnings, loud enough to mask a real link failure

**Package:** `@webpieces/nx-webpieces-rules` (its `package.json` deps), `@webpieces/pr-gate` / `@webpieces/code-rules` (their `bin` maps)
**Version seen:** `0.4.499` (pre-existing, not introduced by the upgrade)
**Severity:** Low impact, high noise — nothing is broken, but the warnings are indistinguishable from a
genuine bin-link failure and appear on EVERY install. Three separate agents reported them as alarming.

**Source:**
- `packages/tooling/nx-webpieces-rules/package.json:19-23` — `workspace:*` deps on the sibling tooling packages
- `packages/tooling/pr-gate/package.json:7-16` — `bin` map pointing at `./src/scripts/*.js`
- `packages/tooling/pr-gate/src/scripts/` — contains `*.ts`, no `*.js`

## Symptom

```
 WARN  Failed to create bin at …/packages/tooling/nx-webpieces-rules/node_modules/.bin/wp-finish-upsert-pr.
   ENOENT: no such file or directory, chmod '…/node_modules/@webpieces/pr-gate/src/scripts/git-finishUpsertPr.js'
 WARN  Failed to create bin at …/.bin/wp-start-upsert-pr. ENOENT: … wp-start-upsert-pr.js'
 WARN  Failed to create bin at …/.bin/wp-start-update.   ENOENT: … wp-start-update.js'
 WARN  Failed to create bin at …/.bin/wp-finish-update.  ENOENT: … wp-finish-update.js'
 WARN  Failed to create bin at …/.bin/wp-validate-code.  ENOENT: … code-rules/src/cli.js'
 … 25 more, repeated across each install pass
```

## Root cause (verified)

`packages/tooling/nx-webpieces-rules/package.json` declares its siblings as workspace deps:

```json
"@webpieces/ai-hook-rules": "workspace:*",
"@webpieces/code-rules":    "workspace:*",
"@webpieces/eslint-rules":  "workspace:*",
"@webpieces/pr-gate":       "workspace:*",
"@webpieces/rules-config":  "workspace:*",
```

pnpm therefore links the **local workspace** copy of `pr-gate` into
`nx-webpieces-rules/node_modules/@webpieces/pr-gate`. That local `package.json` declares:

```json
"bin": { "wp-finish-upsert-pr": "./src/scripts/git-finishUpsertPr.js", … }
```

But the workspace source is TypeScript — `src/scripts/git-finishUpsertPr.ts`. The `.js` files exist only
in the **published tarball**, which ships `files: ["src/**/*"]` compiled in place. So pnpm tries to
`chmod` a `.js` that does not exist in the workspace, once per bin, per install pass.

The **root** `node_modules/.bin/wp-*` are fine — they come from the published packages — which is why
everything works despite the noise.

## Why it is worth fixing

The warnings are visually identical to a real failure. During the 0.4.499 upgrade an agent had to reason
about whether `wp-review-upsert-pr` had actually linked, and the answer was buried in forty lines of
identical-looking red. A genuine broken bin would be invisible here.

## Options (pick after investigating; do not assume)

1. **Point `bin` at compiled output** (`./dist/…`) and add a `prepare`/build step — the conventional fix,
   but check it does not break the published layout, which deliberately compiles in place.
2. **Demote the deps.** Establish whether `nx-webpieces-rules` needs `pr-gate` / `code-rules` at *runtime*
   or only for types and tests. If the latter, `devDependencies` may remove the nested link entirely.
3. **Drop the nested link.** If nothing resolves `@webpieces/pr-gate` from inside `nx-webpieces-rules` at
   runtime, the dependency may simply be unnecessary.

Whatever the fix, the acceptance test is the same: **a clean `pnpm install` prints zero `Failed to create
bin` warnings**, and the root `wp-*` bins still work.

## Before you start — worktree cap

Parallel ticket work runs several subagents at once, each in its own worktree, so
`hookGuards → branch-creation-guard → maxWorktrees` is **10** in `webpieces.config.json`.
`maxLocalBranches` stays at **5** deliberately — branches outside a worktree are worked one at a time.

Both keys are already on `origin/main`, so you inherit them: **change nothing.** If you hit a conflict on
those lines while syncing, take main's value.
