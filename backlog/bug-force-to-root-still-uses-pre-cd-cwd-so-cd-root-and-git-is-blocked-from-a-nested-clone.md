# BUG: `#493` fixed two of three cwd call sites — `gitFromSubdirBlock` still reads the pre-`cd` cwd, so `cd <repo root> && git …` is blocked as "from a subdirectory" whenever the shell sits in a nested clone

**Package:** `@webpieces/ai-hook-rules`
**Version seen:** `0.4.479` / `main` `28c8e67` (the fix commit itself)
**Severity:** Medium — self-inflicted deadlock shape. An agent whose cwd is a nested clone under
`repositories/**` cannot get back to governed work in one command: the force-to-root guard tells it
*"cd to the repo root first: cd <root>"*, but a command that does exactly that is still blocked,
because the check looks at where the shell was **before** the `cd`. The advice the guard prints is
the thing the guard rejects. Recovery requires knowing to issue a bare `cd` as its own separate
tool call first — which is not what the message says.

**Source:**
- `packages/tooling/ai-hook-rules/src/core/runner.ts:277` — passes raw `cwd`
- `packages/tooling/ai-hook-rules/src/core/runner.ts:252` — `effectiveCwd` computed 25 lines earlier
- `packages/tooling/ai-hook-rules/src/core/runner.ts:223-232` — `gitFromSubdirBlock`

## The bug

`#493` introduced `effectiveBashCwd()` and correctly routed the git-boundary check and the
`excludePaths` filter through it:

```ts
// runner.ts:252
const effectiveCwd = effectiveBashCwd(command, cwd);
if (isForeignGitRepo(effectiveCwd, workspaceRoot)) { … }           // :256  ✅ effectiveCwd
const rules = filterByExcludedPaths(…, path.relative(workspaceRoot, effectiveCwd), …);  // :265  ✅
…
const subdirBlock = gitFromSubdirBlock(command, cwd, workspaceRoot); // :277  ❌ raw cwd
```

`gitFromSubdirBlock` then compares the stale value:

```ts
// runner.ts:224
if (!isGitOrGhCommand(command) || path.resolve(cwd) === path.resolve(workspaceRoot)) return null;
```

Three consumers of "where does this command run", two fixed, one missed.

## Repro (observed live)

Shell cwd is `<root>/repositories/acme-ai-manager` (a nested clone) from a previous call. Run:

```bash
cd /abs/path/consumer-monorepo && git push --dry-run origin some-branch
```

**Expected:** the command runs at the governed root, so the normal guards apply — here
`pr-creation-or-push-guard` should block it *on its own merits*.

**Actual:** blocked by force-to-root instead, reporting `You are in: <root>/repositories/acme-ai-manager`
and advising `cd /abs/path/consumer-monorepo` — which is literally the first clause of the command that was
just rejected.

Confirmed the same session: issuing the bare `cd` as a standalone call and then the `git push` as a
second call reaches `pr-creation-or-push-guard` correctly. So the guard chain is right; only the cwd
it reasons about is wrong.

## Fix

One-word change at `:277`:

```ts
const subdirBlock = gitFromSubdirBlock(command, effectiveCwd, workspaceRoot);
```

`effectiveCwd` is already in scope. With it, a command that `cd`s to the root is judged at the root
(no block), and a command that genuinely runs from a subdirectory without `cd`ing still blocks —
which is the behaviour the message describes.

Consider also making this class of bug unrepresentable: `runBashInternal` shadowing the parameter
(`cwd = effectiveBashCwd(command, cwd)` immediately after `loadAndValidate`) would leave no stale
binding for a future call site to pick up by accident. `loadAndValidate(cwd)` needs the raw value
and runs before, so the shadow is safe after that line.

## Test cases

1. cwd = nested clone, command `cd <root> && git status` → NOT force-to-root blocked.
2. cwd = nested clone, command `cd <root> && git push` → blocked by `pr-creation-or-push-guard`
   (right guard, not force-to-root).
3. cwd = `<root>/libraries/db`, command `git status` (no `cd`) → still force-to-root blocked (no regression).
4. cwd = `<root>`, command `git status` → allowed (no regression).
5. cwd = nested clone, command `git push` (no `cd`) → allowed as foreign repo (no regression from #493).
