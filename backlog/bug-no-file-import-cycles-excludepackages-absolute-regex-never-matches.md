# BUG: `no-file-import-cycles` `excludePackages` is a silent no-op (absolute regex vs madge's relative ids)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.450` (also present in `0.4.435`; likely since the option was introduced)
**Severity:** High — the documented escape hatch for foreign cycles **never excludes anything**, and
it fails *silently* (no warning). Worse, because the exclusion is inert, whether the gate passes or
fails depends on an unrelated side effect: whether the excluded package's compiled `lib/` happens to
exist on disk. That makes the gate **non-deterministic across environments** — green on dev
machines and in the GHA PR gate, red in a clean per-service Docker build.

**Source:** `packages/tooling/nx-webpieces-rules/src/executors/validate-no-file-import-cycles/executor.ts`

## The bug

`buildMadgeOptions` (line 187) builds the per-package exclusion as an **absolute**-path regex:

```ts
function buildMadgeOptions(ignoreTypeOnly: boolean, excludePackages: string[], workspaceRoot: string): MadgeOptions {
    const excludeRegExp = [EXCLUDE_BUILD_DIRS, EXCLUDE_DECLARATION_FILES];
    for (const pkg of excludePackages) {
        const dir = resolvePackageDir(pkg, workspaceRoot);   // -> /abs/path/libraries/kami
        if (dir) excludeRegExp.push(`^${escapeRegex(dir)}(/|$)`);   // <-- ^/abs/... anchor
    }
```

`resolvePackageDir` returns an **absolute** path (line 141: `fs.realpathSync(path.dirname(pkgJson))`,
or `path.resolve(workspaceRoot, entries[0])` on the tsconfig-paths fallback).

But madge is invoked with the *project* as its base (line 242):

```ts
const result = await madge(projectRoot, buildMadgeOptions(ignoreTypeOnly, excludePackages, context.root));
```

and madge matches `excludeRegExp` against ids **relative to that base**, e.g.

```
../../libraries/kami/src/brand/brand.entity.ts
```

A pattern anchored `^/Users/.../libraries/kami(/|$)` can never match `../../libraries/kami/...`.
So every `excludePackages` entry is discarded with no diagnostic.

**Corroborating detail in the same file:** the two built-in patterns immediately above are written
*relatively/unanchored* and do work —

```ts
const EXCLUDE_BUILD_DIRS = '(^|/)(node_modules|dist|build|out|coverage|\\.nx|\\.next)(/|$)';   // line 98
const EXCLUDE_DECLARATION_FILES = '\\.d\\.ts$';                                                 // line 99
```

Only the `excludePackages` branch assumes absolute ids.

## Measurement

Run against madge directly, from `services/pg-dataaccess` in the consuming repo, with
`libraries/kami/lib` absent:

| `excludeRegExp` | cycles reported |
|---|---|
| absolute-anchored (**what webpieces builds today**) | **94** |
| relative-anchored (`^\.\./\.\./libraries/kami(/\|$)`) | **0** |
| no exclude at all | 94 |

Absolute-anchored is byte-identical in effect to passing no exclusion.

```js
const madge = require('madge');
const projectRoot = '<repo>/services/pg-dataaccess';
const absDir      = '<repo>/libraries/kami';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base = { fileExtensions: ['ts', 'tsx'] };

await madge(projectRoot, {...base, excludeRegExp: [`^${esc(absDir)}(/|$)`]});          // 94
await madge(projectRoot, {...base, excludeRegExp: ['^\\.\\./\\.\\./libraries/kami(/|$)']}); // 0
await madge(projectRoot, base);                                                        // 94
// sample cycle id: '../../libraries/kami/src/brand-type/brand-type.entity.ts'
```

## Why it hid for so long, and how it bit

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** (an AI can read it directly).
`webpieces.config.json` has had the exclusion configured all along:

```json
"no-file-import-cycles": {
  "mode": "RUN_EVERY_TIME",
  "ignoreTypeOnly": false,
  "excludePackages": ["@mealco-internal/kami"],
  "ignoreModifiedUntilEpoch": 1785016799
}
```

Because the exclusion is inert, the gate's outcome is decided by how `@mealco-internal/kami`
resolves, which depends on whether its build output exists:

| `libraries/kami/lib` | Resolution | Result |
|---|---|---|
| present | `node_modules` → compiled entry → stops at the package boundary | ✅ 0 cycles |
| absent | falls through to the `tsconfig.base.json` alias (`libraries/kami/index.ts` → `./src/*`), walks kami's TypeORM entities | ❌ 94 cycles |

Those 94 are kami's inherent bidirectional ORM relations (`Brand ↔ BrandLocation ↔ Location`, …) —
not fixable by the consumer, which is exactly why `excludePackages` was set.

Consequences observed:
- Dev machines always pass (`lib/` is a leftover from an earlier build).
- The GHA PR gate passes — `nx affected -t lint -t build` builds *all* affected projects, and
  `@mealco-internal/kami:build` happened to land ~2 minutes before the cycle checks.
- A clean Cloud Build container builds one service alone (`nx build <svc>`), nothing forces kami
  first → **CD fails**. Hit `pg-dataaccess` and `mealco-api-auth` on dev CD.

It only became visible when `ignoreModifiedUntilEpoch: 1785016799` (2026-07-25 21:59:59 UTC)
expired and the gate flipped from warn to fail — with no code change to explain it.

Repo-side workaround applied (not a fix for this bug): give the validator its own `nx.json`
`targetDefaults` entry with `dependsOn: ["^build"]` so the dependency is always compiled before
madge runs. Tracked as ONE-2188 / monorepo-nx PR #707.

## Suggested fix

Make the pattern relative to the same base madge is given. `buildMadgeOptions` currently receives
`workspaceRoot`; it needs `projectRoot` (the madge base) as well:

```ts
function buildMadgeOptions(
    ignoreTypeOnly: boolean,
    excludePackages: string[],
    workspaceRoot: string,
    projectRoot: string,               // <-- the base passed to madge()
): MadgeOptions {
    const excludeRegExp = [EXCLUDE_BUILD_DIRS, EXCLUDE_DECLARATION_FILES];
    for (const pkg of excludePackages) {
        const dir = resolvePackageDir(pkg, workspaceRoot);
        if (!dir) continue;
        // madge ids are relative to projectRoot, e.g. '../../libraries/kami/src/x.ts'
        const rel = path.relative(projectRoot, dir).split(path.sep).join('/');
        excludeRegExp.push(`^${escapeRegex(rel)}(/|$)`);
    }
    ...
}
```

Notes for whoever fixes it:
- Normalise `path.sep` → `/` (shown above); madge ids always use forward slashes, so a raw
  `path.relative` breaks on Windows.
- `resolvePackageDir` uses `fs.realpathSync`, so on a pnpm workspace with symlinked packages the
  resolved dir may sit outside `projectRoot`'s realpath. Worth realpath'ing `projectRoot` too
  before `path.relative`, or the computed relative path won't line up with madge's ids.
- Consider warning when an `excludePackages` entry resolves but then matches **zero** traversed
  files — that would have surfaced this immediately instead of failing silently. `resolvePackageDir`
  already warns on *unresolvable* entries; the gap is entries that resolve but never match.
- Regression test: assert that a project importing an excluded workspace package reports 0 cycles
  **with the excluded package's build output deleted**. With `lib/` present the assertion passes
  even with the bug, which is precisely how this escaped.
