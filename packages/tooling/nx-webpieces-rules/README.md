# @webpieces/nx-webpieces-rules

Nx inference plugin that auto-creates webpieces validation targets (architecture
graph checks, code-size/style rules, and a per-project circular-import gate)
without any manual `project.json` wiring.

Install `@webpieces/webpieces-tooling` for the complete toolchain. This package implements the Nx plugin and executors; it does not aggregate hook or PR workflow packages.

Add it to `nx.json`:

```jsonc
{
  "plugins": ["@webpieces/nx-webpieces-rules"]
}
```

## Circular file-import gate (`validate-no-file-import-cycles`)

Each project gets a `validate-no-file-import-cycles` target that runs
[`madge`](https://github.com/pahen/madge) over its TypeScript sources and fails
on an import cycle. `madge` is bundled as a pinned dependency, so there is **no
runtime `npx` fetch** (which previously corrupted CI npx caches).

It is wired into the build: the `@nx/js:tsc` target default lists it in
`dependsOn`, so `nx affected --target=ci` (→ `ci` → `build`) and
`nx run-many --target=build` both run it.

### Configuration

On/off and a time-boxed grace window come from `webpieces.config.json` at the
workspace root — the same source of truth as every other webpieces rule — under
the rule key `no-file-import-cycles`:

```jsonc
{
  "rules": {
    "no-file-import-cycles": {
      "mode": "ON",                            // "OFF" disables the gate everywhere
      "turnOffRuleUntilEpoch": 1771931925,  // epoch SECONDS — while now < epoch,
                                               //   cycles are REPORTED but the build
                                               //   PASSES; after it, the gate fails again
      "ignoreTypeOnly": false                  // when true, ignore `import type`
                                               //   re-export cycles (erased at compile
                                               //   time, harmless at runtime)
    }
  }
}
```

Semantics, mirroring the method/file-size dated-disable model:

| Situation                                   | Result                          |
| ------------------------------------------- | ------------------------------- |
| `mode: "OFF"`                               | Skipped (passes), no madge run  |
| Cycle found, no `turnOffRuleUntilEpoch`  | **Fails**                       |
| Cycle found, `now < turnOffRuleUntilEpoch` | Reported but **passes** (warn) |
| Cycle found, `now >= turnOffRuleUntilEpoch` | **Fails** again               |
| No cycle                                    | Passes                          |

The grace window lets you turn a strict gate on against an existing codebase
without an open-ended "off everywhere" escape hatch — the debt can't be silently
forgotten because the gate starts failing again after the date.

### Disabling at the Nx layer

Setting `circularDeps.enabled: false` in the plugin options removes the target
entirely (rather than toggling it via config). Prefer `mode: "OFF"` instead — it
keeps the target present so any `dependsOn` references don't dangle.

## View saved architecture and refresh explicitly

`pnpm arch:visualize` and `pnpm arch:visualize-runtime` open saved generated
snapshots. They render presentation files and open the browser without regenerating
architecture, API contract, or runtime graph facts. Source edits do not update the
snapshot. Freshness is unknown because these artifacts do not record reliable
generation provenance; checkout/file modification times are not generation times.

Refresh explicitly, then view:

```sh
pnpm arch:generate
pnpm arch:visualize
pnpm arch:visualize-runtime
```

In consuming workspaces without these npm shortcuts, use
`pnpm nx run architecture:generate`, `pnpm nx run architecture:visualize`, and
`pnpm nx run architecture:visualize-runtime`. The compile graph's configured
`graphPath` (or `--graphPath=...`) is still supported. Missing or unusable saved
artifacts fail with the artifact path and refresh command; viewing never generates
as a fallback. A failed generation remains a failure, and viewing any saved files
afterward does not establish that refresh succeeded. Browser-open failures print
the HTML path for manual opening. Architecture/API validation and CI still run
their existing checks independently of visualization.
