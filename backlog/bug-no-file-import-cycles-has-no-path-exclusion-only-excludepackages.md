# BUG: `no-file-import-cycles` has no path-based exclusion — `excludePackages` can only exclude *other* packages, never a path inside the project being checked

**Package:** `@webpieces/nx-webpieces-rules` (schema in `@webpieces/rules-config`)
**Version seen:** `0.4.458` (present since the rule was introduced)
**Severity:** High — **missing escape hatch**, not a wrong result. `no-file-import-cycles` is the only
structural gate with *no* path surface at all: no `allowedPaths`, no `excludeRegExp`, and no working
inline disable. `excludePackages` resolves **npm package names**, so it can exclude a *sibling
package* and nothing else. A cycle inside the project under test — generated code, vendored code, or
a deliberate bidirectional domain model — has no exemption below workspace scope. The only two levers
are `mode: "OFF"` and bumping `ignoreModifiedUntilEpoch`, and both blanket the entire workspace.

**Source:**
- `packages/tooling/rules-config/src/rule-configs.ts:526` (`NoFileImportCyclesConfig`)
- `packages/tooling/nx-webpieces-rules/src/executors/validate-no-file-import-cycles/executor.ts:250`
  (`buildMadgeOptions`)

Distinct from
[`bug-no-file-import-cycles-excludepackages-absolute-regex-never-matches`](./bug-no-file-import-cycles-excludepackages-absolute-regex-never-matches.md),
which is **fixed** in this tree (`buildExcludePattern` now anchors relative to the madge base and
warns on resolves-but-matches-nothing). That bug was "the package exclusion silently does nothing."
This one is "there is no *path* exclusion to begin with."

## The bug

`NoFileImportCyclesConfig` exposes exactly three knobs plus the base schema:

```ts
// rule-configs.ts:526
export class NoFileImportCyclesConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    ignoreTypeOnly?: boolean;
    excludePackages?: string[];

    static readonly SCHEMA: SchemaShape<NoFileImportCyclesConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ignoreTypeOnly: FieldDef.optional('boolean'),
        excludePackages: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
```

The schema validator states the complete surface itself. Attempting to document the situation with a
sibling `*Why` key (the convention this repo's config uses elsewhere) prints the authoritative list:

```
webpieces.config.json has 1 validation error(s) — fix ALL, then retry:

  • [no-file-import-cycles] Unknown field "excludePackagesWhy". Valid fields:
    [mode, ignoreTypeOnly, excludePackages, ignoreModifiedUntilEpoch, ignoreRuleWhileOnBranch].
```

Five fields, and not one of them is path-scoped. `ignoreRuleWhileOnBranch` is branch-scoped, so it
cannot hold on `main`; the other four are the rule's behaviour, its package list, and a global
time-box.

`excludePackages` entries go through `resolvePackageDir(pkg, workspaceRoot)` — a **package-name**
lookup (`node_modules` resolution, with a `tsconfig.base.json` paths fallback). To exempt
`src/generated/**` inside the project you would have to make that directory its own npm package with
its own `package.json`. There is no other route: `buildMadgeOptions` builds `excludeRegExp` from two
hardcoded constants plus the resolved package dirs, and nothing else can contribute to it.

```ts
// executor.ts:250
export function buildMadgeOptions(
    ignoreTypeOnly: boolean,
    excludePackages: string[],
    workspaceRoot: string,
    projectRoot: string,
): MadgeOptions {
    const excludeRegExp = [EXCLUDE_BUILD_DIRS, EXCLUDE_DECLARATION_FILES];
    const base = realpathOrSelf(projectRoot);
    for (const pkg of excludePackages) {
        const dir = resolvePackageDir(pkg, workspaceRoot);   // <-- package NAME in, dir out
        if (dir) excludeRegExp.push(buildExcludePattern(dir, base, pkg));
    }
    const options: MadgeOptions = { fileExtensions: ['ts', 'tsx'], excludeRegExp };
    ...
}
```

`MadgeOptions.excludeRegExp` is already declared `string[]` on line 55 of the same file. The array
consumers would want to append to is right there — it just isn't reachable from config.

### The rest of the family already has this

Five sibling rules carry `allowedPaths`, matched with the shared `isPathExcluded`
glob/prefix/segment semantics:

| Config class | `rule-configs.ts` |
|---|---|
| `NoDestructureConfig` | 198 |
| `NoSymbolDiTokensConfig` | 275 |
| `NoFunctionOutsideClassConfig` | 312 |
| `InjectAnnotationNotNeededForConcreteClassConfig` | 335 |
| `NoJsFilesConfig` | 586 |

`NoFileImportCyclesConfig` has no equivalent, and unlike `no-destructure` (see the neighbouring
backlog item) it has no `disableAllowed`/inline-comment path either — the executor reports madge's
cycle list and never consults per-file markers. So this rule is strictly the *most* locked-down of
the set while governing the construct most likely to be legitimately unavoidable.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/onetablet/monorepo-nx2`** (an AI can read it directly).

```json
"no-file-import-cycles": {
  "mode": "RUN_EVERY_TIME",
  "ignoreTypeOnly": false,
  "excludePackages": ["@mealco-internal/kami"],
  "ignoreModifiedUntilEpoch": 1785016799
}
```

That epoch is **2026-07-25 21:59:59 UTC**; as of 2026-07-28 the rule is live and strict.

```
$ nx run @mealco-internal/fuji-part1-api:validate-no-file-import-cycles

❌ Found 2 circular import cycle(s) in @mealco-internal/fuji-part1-api:
  1. src/modules/item/item.responses.dto.ts → src/modules/category/category.responses.dto.ts → src/modules/item/item.responses.dto.ts
  2. src/modules/item/item.responses.dto.ts → src/modules/modifier/modifier.responses.dto.ts → src/modules/item/item.responses.dto.ts
```

**These cycles are correct and deliberate.** `fuji-part1-api` is an OpenAPI contract library whose
resources are bidirectional by definition — a Category holds Items, an Item holds Categories:

```ts
// category.responses.dto.ts:61      items?: ItemDto[];
// item.responses.dto.ts:177         categories?: CategoryDto[];
```

The second cycle is not merely tolerated, it is **already solved at the framework layer** and the
solution is documented in-source (`modifier.responses.dto.ts:163`):

```ts
@ApiProperty({
    // ONE-1555: lazy resolver breaks the FullItem -> FullModifierGroup ->
    // FullModifierOption -> Item bidirectional cycle. With an eager `type: ItemDto`,
    // @nestjs/swagger@7.2.0 throws "circular dependency (property key: item)" while
    // building the schema, crashing every consumer at SwaggerModule.createDocument().
    description: 'item the modifier option represents',
    type: () => ItemDto,
})
item?: ItemDto;
```

So the gate fails a file pair where `@nestjs/swagger` **supplies** the escape hatch (`type: () =>
ItemDto`), the developer **used** it, and the cycle is required by the API contract. There is no way
to say "this pair is known and handled."

`excludePackages` cannot help: `item`, `category` and `modifier` are directories inside the single
package `@mealco-internal/fuji-part1-api`, which is the package being checked.

Options actually available to the consumer today, none of which is the one wanted:

| Option | Effect |
|---|---|
| `mode: "OFF"` | kills the gate for **every** project in the workspace |
| bump `ignoreModifiedUntilEpoch` | re-opens the grace window **workspace-wide**, silently |
| split the DTOs into a separate npm package | restructure a published contract lib to satisfy a linter |
| break the cycle | changes the REST resource graph; contradicts ONE-1555 |

### The generated-code case is the same hole

The repo also carries generated trees that sit **inside** a project and cannot be named as packages:

- `.gitignore:15` → `**/src/generated`
- `libraries/apis/fuji-part1-api/.gitignore:2` → `spec-build/` (emitted by the `emit-spec` target)

Neither is reachable by `excludePackages`. `EXCLUDE_BUILD_DIRS` does not cover them either — its
segment alternation is `(^|/)(node_modules|dist|build|out|coverage|\.nx|\.next)(/|$)`, which matches
the segment `build` exactly and therefore **not** `spec-build`. Those trees happen to hold no `.ts`
today, so they are latent rather than live — but the moment a generator emits TypeScript into one,
the consumer is back to the workspace-wide levers above.

## Suggested fix (KISS)

Pass `excludeRegExp` straight through. `MadgeOptions.excludeRegExp` is already `string[]`, so this is
a concat, not a translation layer.

**1. `rule-configs.ts:526`** — one field, one schema entry:

```ts
// `excludeRegExp` is handed to madge verbatim. Patterns are matched against madge's ids, which are
// RELATIVE TO THE PROJECT being checked (e.g. 'src/generated/api.ts', '../../libraries/foo/x.ts').
export class NoFileImportCyclesConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    ignoreTypeOnly?: boolean;
    excludePackages?: string[];
    excludeRegExp?: string[];

    static readonly SCHEMA: SchemaShape<NoFileImportCyclesConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ignoreTypeOnly: FieldDef.optional('boolean'),
        excludePackages: FieldDef.optional('string[]'),
        excludeRegExp: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
```

**2. `executor.ts:250`** — thread it in:

```ts
export function buildMadgeOptions(
    ignoreTypeOnly: boolean,
    excludePackages: string[],
    workspaceRoot: string,
    projectRoot: string,
    userExcludeRegExp: string[] = [],
): MadgeOptions {
    const excludeRegExp = [EXCLUDE_BUILD_DIRS, EXCLUDE_DECLARATION_FILES, ...userExcludeRegExp];
    ...
}
```

and at the call site (line 313), alongside the two options already read on 307-308:

```ts
const userExcludeRegExp = (rule?.options['excludeRegExp'] as string[] | undefined) ?? [];
const result = await madge(
    projectRoot,
    buildMadgeOptions(ignoreTypeOnly, excludePackages, context.root, projectRoot, userExcludeRegExp),
);
```

**3. `reportCycles`** — print the new lever in the failure message, next to the existing
`ignoreModifiedUntilEpoch` / `mode: "OFF"` lines, so it is discoverable from the failure rather than
from the source:

```
To exempt a path (generated code, a deliberate bidirectional model), add a pattern to
"no-file-import-cycles".excludeRegExp in webpieces.config.json. Patterns match paths
RELATIVE TO THE PROJECT, e.g. "^src/generated/" or "^src/modules/(item|category)/".
```

## Notes for whoever fixes it

- **The relative-id trap is the whole risk of a raw pass-through.** madge matches `excludeRegExp`
  against ids relative to the base it was invoked with (`projectRoot`), so a consumer's natural first
  attempt — a workspace-relative pattern like `^libraries/apis/fuji-part1-api/src/generated/` — will
  silently match nothing. That is exactly the failure mode the neighbouring
  `excludePackages`-absolute-regex bug documented, and a pass-through hands it to every consumer.
  Mitigate cheaply: warn when a supplied pattern starts with `^/` (absolute) or matches zero
  traversed ids. The `hasSourceFiles` warning added for `buildExcludePattern` is the precedent —
  reuse the same "resolves but matches nothing" idea against madge's actual traversal output.
- **Consider `excludePaths` (globs) instead of / alongside raw regex.** Every sibling rule uses
  `isPathExcluded` with glob/prefix/segment semantics, and consumers already write globs in
  `excludePaths`, `allowedPaths` and `.gitignore`. A glob list converted internally to
  project-relative regex would be consistent with the family *and* would sidestep the relative-id
  trap entirely, since the conversion owns the base. Raw `excludeRegExp` is the smaller change and
  strictly more expressive; the glob form is the one a consumer gets right on the first try. Shipping
  both is defensible — regex as the escape valve, globs as the ergonomic default.
- **Regression test:** a project containing a genuine A→B→A cycle must report **0** cycles when a
  pattern covering one of the two files is supplied, and must still report the cycle when the pattern
  is workspace-anchored instead of project-anchored (asserting the warning fires). Testing only the
  happy path would pass even if the pattern were being dropped.
- **Whole-family audit, same as the `no-destructure` item recommends:** this is the second rule found
  with a policy hole at path granularity. `allowedPaths` is now on five configs and absent from
  several more. Promoting a path-exemption field into `BASE_RULE_SCHEMA` would end the "which rules
  happen to support the knob" surprise permanently — larger than this bug, but this is the second
  consumer-visible instance.
