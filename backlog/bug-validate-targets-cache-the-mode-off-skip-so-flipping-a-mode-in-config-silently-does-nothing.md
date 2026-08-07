# BUG: `architecture:validate-*` nx targets cache the `mode: OFF` skip message, so flipping a rule to `RUN_EVERY_TIME` in `webpieces.config.json` silently keeps skipping it — and CI reports green

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.479`
**Severity:** High — a validator a client believes they just enabled does not run, and the build is
green either way. The failure is silent and reads exactly like "the validator ran and passed." Worse
in CI than locally: a warm nx cache means the rule can stay off across many commits after the config
says it is on.

**Source:** `packages/tooling/nx-webpieces-rules/src/validation-targets.ts` (target `inputs` omit
`webpieces.config.json`)

## Repro (observed live on consumer-monorepo, upgrading 0.4.463 → 0.4.479)

1. New release adds `validate-no-architecture-cycles`. Declare it as `"mode": "OFF"` to get the config
   validator passing, then run `pnpm run webpieces:ci`. The target runs and prints:
   `⏭️  Skipping validate-no-architecture-cycles (mode: OFF) — configured in webpieces.config.json`
   nx caches that as the task's successful output.
2. Flip the same rule to `"mode": "RUN_EVERY_TIME"` and re-run `pnpm run webpieces:ci`:

```
> nx run architecture:validate-no-architecture-cycles  [existing outputs match the cache, left as is]
⏭️  Skipping validate-no-architecture-cycles (mode: OFF) — configured in webpieces.config.json
```

The skip message is *replayed from cache* — and it still says `mode: OFF` while the config on disk
says `RUN_EVERY_TIME`. Exit 0, whole gate green.

3. `pnpm nx run architecture:validate-no-architecture-cycles --skip-nx-cache` runs it for real:

```
🔄 Validating No Circular Dependencies
✅ No circular dependencies detected!
📈 Summary: 44 projects, all acyclic
```

Same for `validate-architecture-unchanged`, `validate-packagejson`, `validate-versions-locked` —
all four showed `[existing outputs match the cache, left as is]` after the mode flip.

The tell is subtle and easy to miss: the cached line *names the stale mode*. Without noticing that
`mode: OFF` contradicts the file you just edited, this looks like a passing validator.

## Cause

`webpieces.config.json` is not among these targets' `inputs`, so nx's hash is unchanged when only the
mode changes. Every `validate-*` target reads its mode from that file at runtime, which makes the file
a genuine input to all of them.

## Fix

Add the config to the `inputs` of every generated `validate-*` target, e.g.

```ts
inputs: [ …existing, '{workspaceRoot}/webpieces.config.json' ]
```

A blunter alternative — mark the targets `cache: false` — costs real time on `validate-architecture-unchanged`
and `validate-packagejson`, which do full graph work; the input fix keeps caching and is correct.

Worth auditing the same way: any other generated target whose behaviour is read from
`webpieces.config.json` at runtime (the `rules`-driven lint targets look likely).

## Test cases

1. Run a `validate-*` target at `mode: OFF` (populates cache) → flip to `RUN_EVERY_TIME` → re-run
   WITHOUT `--skip-nx-cache` → the validator actually executes.
2. Reverse (`RUN_EVERY_TIME` → `OFF`) → re-run → prints the skip, does not replay a stale pass.
3. Two consecutive runs with no config change → second is a cache hit (caching not defeated wholesale).
4. Editing an unrelated key in `webpieces.config.json` invalidates (acceptable over-invalidation) —
   assert it does not error.
