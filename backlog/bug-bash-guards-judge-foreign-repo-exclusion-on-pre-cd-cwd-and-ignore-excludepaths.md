# BUG: bash guards decide the foreign-repo exclusion from the *pre-`cd`* cwd, and never apply `excludePaths.guards` at all — so `cd repositories/<clone> && git push` is blocked in an explicitly excluded tree

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** current `main` (`302dfb1`)
**Severity:** High — an agent cannot push or open a PR in *any* nested clone under `repositories/**`,
even though that path is configured as excluded **and** the bash path has a dedicated foreign-repo
escape hatch. Both protections are present in the code and both miss. The agent is left with no
legal path at all: the guard redirects to `pnpm wp-start-upsert-pr`, which does not exist in the
nested repo, so the fix hint is unactionable and the work dead-ends on a human hand-off.

**Source:**
- `packages/tooling/ai-hook-rules/src/core/runner.ts:204-210` (foreign-repo check, keyed on `cwd`)
- `packages/tooling/ai-hook-rules/src/core/runner.ts:187-230` (`runBashInternal` — never calls `filterByExcludedPaths`)
- `packages/tooling/ai-hook-rules/src/core/runner.ts:105`, `:163` (the only two call sites, both file-path paths)
- `packages/tooling/ai-hook-rules/src/core/types.ts:117-146` (`BashContext` carries no cwd/path)
- `packages/tooling/ai-hook-rules/src/core/rules/pr-creation-or-push-guard.ts:67-76` (matches command text only)

## Repro

In a client repo (`consumer-monorepo`) whose `webpieces.config.json` contains:

```json
"excludePaths": {
  "rules":  ["repositories/**", "tools/**"],
  "guards": ["repositories/**", "tools/**"]
}
```

with a separate git clone at `repositories/acme-ai-manager`, run one Bash call:

```bash
cd /abs/path/consumer-monorepo/repositories/acme-ai-manager && git push -u origin feature/x
```

**Expected:** allowed. It is a different git repo, and `repositories/**` is excluded for `guards`.

**Actual:** blocked by `pr-creation-or-push-guard`, pointing at `pnpm wp-start-upsert-pr` — a command
the nested repo does not have (no `wp` binaries, no npm scripts). Dead end.

## Defect 1 — the foreign-repo exclusion is evaluated before the `cd` runs

`runBashInternal` has exactly the escape hatch this case needs:

```ts
// runner.ts:204-210
const gitRoot = gitToplevel(cwd);
if (gitRoot !== null && path.resolve(gitRoot) !== path.resolve(workspaceRoot)) {
    // cwd is inside a DIFFERENT git repo than this webpieces.config governs (e.g. a clone under
    // repositories/). Out of scope → allow, hands-off. Intentional, not a silent hole.
    return null;
}
```

The comment names this exact scenario. It fails because `cwd` is the shell's cwd **at hook time** —
PreToolUse fires before the command executes, so the in-command `cd` has not happened yet.
`gitToplevel(cwd)` returns the *outer* repo root, which equals `workspaceRoot`, so the branch is not
taken and the guard proceeds to block.

The exclusion therefore only works when cwd *already* happens to be inside the nested clone from a
previous call. That is the rare case, for two reasons:

1. Claude Code's Bash tool does not reliably persist cwd across calls, so agents are trained to write
   self-contained `cd X && …` commands.
2. Client instructions actively mandate that shape. `consumer-monorepo`'s `AGENTS.md` hard rule 1 is
   *"Run all git operations inside the specific repo directory"*, with the literal example
   `cd repositories/fuji && git checkout -b feature/xyz && git commit … && git push origin feature/xyz`.

So the documented, instructed way to work in a nested repo is precisely the form that defeats the
exclusion. Observed live: the guard blocked that exact `cd … && git push`, then the same session's
`cd … && <read>` calls were judged against the outer repo too.

**Fix:** derive the effective cwd from the command before the git-root comparison — parse a leading
`cd <path> &&` / `pushd` prefix and resolve `gitToplevel()` from there. Falling back to the current
behaviour when no `cd` prefix is present keeps it conservative. A cheap, strictly-additive version:
if the command contains **any** `cd <path>` whose resolved git root differs from `workspaceRoot`,
treat the command as out of scope.

## Defect 2 — `excludePaths.guards` is never applied on the bash path

Independent of the cwd issue, the configured exclusion is silently ignored for every bash guard.
`filterByExcludedPaths` has exactly two call sites:

- `runner.ts:105` — the Write/Edit path (`run()`)
- `runner.ts:163` — the Read path (`runRead()`)

`runBashInternal` (`:187-230`) never calls it. It goes straight from `loadRules` → `filterByMode` →
`checkConfigSync` → the rule loop. So a client who writes `"guards": ["repositories/**"]` gets that
honoured for Read/Edit and silently dropped for Bash.

This is arguably the more surprising half: the config surface exists, validates, is documented as
exempting vendored trees (`setup.ts:155-156`: *"a client adds paths (e.g. `repositories/**`) to exempt
vendored trees"*), and has no effect on the tool class where it matters most for nested clones.

The structural blocker is that `BashContext` (`types.ts:117-146`) carries only `command`,
`commandCode`, `workspaceRoot`, and `options` — **no cwd and no relativePath** — so there is nothing
for `filterByExcludedPaths(rules, relativePath, …)` to match against. Fixing defect 2 properly means
adding the effective path to `BashContext` first, which is the same information defect 1 needs.

**Suggested shared fix:** put an `effectiveCwd` (post-`cd` resolution) and its `relativePath` on
`BashContext`, then (a) use it for the `gitToplevel` comparison and (b) pass its `relativePath` to
`filterByExcludedPaths` in `runBashInternal`. One piece of derived state repairs both.

## Why this is not "just ask the human"

The guard's fix hint says: *"If a HUMAN genuinely needs an out-of-band push (no PR), do NOT do it
yourself — ask them to run the push."* That is right for the **governed** repo, where the gated flow
is the alternative. In a nested clone there is no gated flow to redirect to, so the guard is enforcing
a workflow that does not exist there and every push becomes a human hand-off. The two protections
that were designed to prevent this — the foreign-repo check and `excludePaths.guards` — are both
present and both miss.

Note the blast radius is wider than pushes: the same `runBashInternal` gate fronts every bash guard,
so `redirect-how-to-merge-main`, `feature-branch-guard`, and friends all reason about the outer repo's
git state while the agent works inside a nested clone.

## Test cases

1. `cd <nested clone> && git push` from a workspace whose cwd is the outer root → ALLOW (defect 1).
2. Same, with `excludePaths.guards: []` and the nested clone still a distinct git repo → ALLOW
   (foreign-repo rule alone is sufficient; exclusion config is not required).
3. `cd repositories/x && git push` where `repositories/x` is **not** its own git repo but IS in
   `excludePaths.guards` → ALLOW (defect 2 — exercises the exclusion independently of git roots).
4. Plain `git push` at the governed repo root → still BLOCKED (no regression).
5. `cd <nested clone> && git push` where the nested path is NOT excluded and shares the outer git
   root → still BLOCKED (no over-broad allow).
6. `echo "cd repositories/x && git push"` → still BLOCKED (prose/quoted stripping must not be
   weaponised into a bypass; `commandCode` already handles this, assert it still does).
