# nx-webpieces-rules — needed changes (from monorepo-nx, 2026-06-05)

Found while debugging why `monorepo-nx`'s **Release** pipeline (`nx run-many -t build`)
went red after adopting `wp-ci`. Two of these are real bugs in this plugin; the
third is a feature request. Author: Dean (via Claude Code investigation).

---

## STATUS — all three addressed (2026-06-05)

The circular-dep check is no longer a raw `nx:run-commands` `npx madge` shell-out.
It is now the **`validate-no-file-import-cycles` executor**
(`src/executors/validate-no-file-import-cycles/`), which:

1. **#1 fixed** — `madge` is pinned in `package.json` `dependencies` (`"madge": "8.0.0"`)
   and invoked via the bundled module (programmatic API), so there is no runtime
   `npx` fetch to corrupt the cache.
2. **#2 done** — on/off and a time-boxed grace window come from `webpieces.config.json`
   under the rule key `no-file-import-cycles`, exactly like the method/file-size rules:
   ```jsonc
   "no-file-import-cycles": {
     "mode": "ON",                      // "OFF" disables the gate everywhere
     "ignoreModifiedUntilEpoch": 1771931925,  // epoch SECONDS: while now < epoch,
                                        //   cycles are REPORTED but the gate PASSES;
                                        //   after it, fails again
     "ignoreTypeOnly": true             // bonus: ignore `import type` re-export cycles
   }
   ```
   (Per-project/per-cycle granularity from the original ask was descoped — the grace
   window is workspace-wide, matching every other webpieces rule.)
3. **#3 done** — the executor now reads its on/off from `webpieces.config.json` `mode`,
   so the recommended toggle no longer deletes the target. The target always exists →
   no dangling `dependsOn`. (`circularDeps.enabled:false` in nx.json still removes the
   target entirely for anyone who wants that; the sharp edge below only applies to it.)

Original report retained below for context.

---

## 1. BUG (publish-blocker): `madge` is invoked but never declared as a dependency

`src/plugin.ts:654` (`createCircularDepsTarget`) emits:

```ts
command: 'npx madge --circular --extensions ts,tsx .'
```

…but this package's `package.json` does **not** list `madge` in `dependencies`,
`peerDependencies`, or `devDependencies` (only `@webpieces/* workspace:*`).

### Why it breaks consumers

When a repo installs the **published** plugin, madge never comes with it — there is
no `node_modules/madge`, no `node_modules/.bin/madge`. The target's `npx madge`
is therefore forced to **download `madge@8` at runtime**. On CI runners that
on-the-fly fetch is unreliable and corrupted the npx cache:

```
> npx madge --circular --extensions ts,tsx .
npm WARN exec The following package was not found and will be installed: madge@8.0.0
npm WARN tar TAR_ENTRY_ERROR ENOENT ... (extraction corrupted)
Error: Cannot find module 'util-deprecate'   (readable-stream → bl → ora → madge/bin/cli.js)
  code: 'MODULE_NOT_FOUND'
```

madge crashed **before analyzing anything**, so every `validate-no-file-import-cycles`
target failed and the whole `build` (which depends on it) failed → nothing publishes.
This sank two consecutive `main` Release runs in monorepo-nx (identical npx cache hash).

### Fix

Declare madge so it's pinned and installed with the plugin, and stop relying on a
runtime fetch:

```jsonc
// packages/tooling/nx-webpieces-rules/package.json
"dependencies": {
  "madge": "8.0.0",          // exact-pinned (matches webpieces' no-range rule)
  ...
}
```

And invoke the local binary deterministically instead of `npx` fetching:

```ts
// option A — let npx resolve the now-local bin (works once madge is a dep)
command: 'npx madge --circular --extensions ts,tsx .'
// option B — invoke the resolved bin directly (most deterministic; no npx network path)
command: 'madge --circular --extensions ts,tsx .'   // nx run-commands resolves node_modules/.bin
```

Until this ships, every wp-ci adopter must pin `madge` themselves at the workspace root.

---

## 2. FEATURE REQUEST: time-boxed `ignoreUntil` epoch for circular-dep checks

Today, circular-dep checking is **all-or-nothing**:

```ts
export interface CircularDepsOptions {
  enabled?: boolean;          // global on/off
  targetName?: string;
  excludePatterns?: string[]; // per-project skip (glob on projectRoot)
}
```

There is **no time-boxed ignore** for cycles — unlike the code-size validations,
which already support dated disables via `validationMode: 'NORMAL'` (see
`ValidationOptions` / plugin.ts:55-61). When you turn a strict cycle gate on
against an existing codebase, you discover pre-existing cycles and your only
options are "off everywhere" or "exclude the whole project forever" — both of
which silently lose coverage with no expiry and no nudge to actually fix it.

### What we want

An `ignoreUntil` epoch so a repo can **time-box** known cycles — the gate passes
until the date, then automatically starts failing again so the debt can't be
forgotten. Ideal granularity is per-project (and, if feasible, per-cycle):

```jsonc
"circularDeps": {
  "enabled": true,
  "ignoreUntil": "2026-06-19",            // workspace-wide grace window (ISO date or epoch)
  "ignore": [
    { "project": "libraries/apis", "until": "2026-06-19", "reason": "ONE-XXXX fuji DTO cycle" },
    { "project": "services/webhook-proxy-handler", "until": "2026-06-19", "reason": "platform-sdk type-only" }
  ]
}
```

Semantics: while `now < until`, the target still **runs madge and reports**, but
exits 0 (warn, don't fail). After `until`, it fails again. This mirrors the
existing dated-disable model used for method/file-size rules, applied to cycles.

Bonus: a flag to **ignore type-only import cycles** (madge flags `import type`
re-export cycles like a barrel `export *` + `import type {X} from './barrel'`,
which are erased at compile time and harmless at runtime).

---

## 3. CONFIRM/DOCUMENT: the on/off toggle already exists ("only run madge if it's on")

You asked whether madge can be made conditional — **it already is**:
`circularDeps.enabled: false` makes `addPerProjectTargets` skip target creation
entirely (plugin.ts:237), so madge never runs anywhere. Worth documenting in the
README alongside `excludePatterns`, because it's the current escape hatch (and is
what monorepo-nx is using as the 2-week interim until #2 lands and the cycles are
fixed).

One sharp edge: consumers wire `validate-no-file-import-cycles` into
`@nx/js:tsc.dependsOn` in their `nx.json`. With `enabled:false` the target no
longer exists, leaving a dangling `dependsOn` entry. Nx tolerates a missing
dependsOn target (skips it), but the README should call this out so people also
remove the `dependsOn` line when disabling, to keep the build graph clean.
