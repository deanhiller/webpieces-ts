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

`webpieces.config.json` declares each owning pack and its config path in the root
`rulePacks` array. For example, the Nx entry is:

```json
{
  "package": "@webpieces/nx-webpieces-rules",
  "config": ".webpieces/rules/nx.json"
}
```

Keep the other selected owners and required root settings. Policy settings come
from the declared owner file's direct policy-ID map. This entry belongs directly
in `.webpieces/rules/nx.json` (an excerpt; the other owned policies also require
explicit settings):

```json
{
  "no-file-import-cycles": {
    "mode": "RUN_EVERY_TIME",
    "turnOffRuleUntilEpoch": 0,
    "turnOffRuleWhileOnBranch": null,
    "ignoreTypeOnly": false
  }
}
```

Use complete `OFF` settings for an intentional opt-out. `ignoreTypeOnly: true`
ignores type-only import/re-export cycles. A future `turnOffRuleUntilEpoch` value
uses epoch seconds; `0` and a `null` branch hatch keep enforcement active.
After reviewing the declarations, `pnpm wp-rules-sync` explicitly seeds missing
owner settings and refreshes the lock/catalog artifacts. Review and commit its
changes; normal loading never supplies missing required settings.

Semantics, mirroring the method/file-size dated-disable model:

| Situation                                   | Result                          |
| ------------------------------------------- | ------------------------------- |
| `mode: "OFF"`                               | Skipped (passes), no madge run  |
| Cycle found, `turnOffRuleUntilEpoch: 0`  | **Fails**                       |
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

### Color modes and the page shell

`architecture/dependencies.html` opens with the graph filling the viewport and every control
in a collapsible dark drawer on the left: the color mode, a type-to-search **Lock** field
(`/` focuses it, `Esc` unlocks), a **Hide unconnected** toggle, the legend (with a pop-out
button) and the edge key. Help is the **?** popover, zoom floats bottom-right, and
**Responsibilities** opens a right-hand panel from the drawer footer.

The graph answers one question at a time. Pick a mode in the drawer, from **Mode ▸** in any
box's menu, or with keys `1` `2` `3`; the choice is remembered per viewer and deep-linkable as
`#runtime`, `#architecture` or `#impact`.

- **Runtime** — where the code can run. Base runtimes are equal vertical stripes in the fixed
  order browser | node | react-native; angular and react are an inset inside the browser
  stripe, express inside the node stripe. A box may depend on a box that carries every color it
  has. A box with several stripes or an inset carries its name on a light plate between two
  stripe bands, so the text never straddles two colors.
- **Architecture** — servers · clients · APIs. A solid fill by role (server, client, app, bundle,
  api-lib, api-client, designed-lib, lib); framework color is not shown.
- **Impact** — what this branch touches. `architecture:generate` runs
  `nx show projects --affected --base=<fork point> --json` (no `--head`, so uncommitted and
  untracked work counts). Projects that own a changed file, by nx's own file ownership, are solid
  amber ("touched — files changed on this branch"); the rest of the affected set is light amber
  ("affected — tests and build re-run"); every transitive dependency of the affected set that is
  not itself affected is light slate with a dashed border ("build input — compiled or restored from
  cache, unchanged"); everything else is grey. The drawer shows the counts per shade. The answer is per branch, so
  it is written to `architecture/.impact/dependencies.impact.js`, never into the committed html or
  json. That directory holds its own `.gitignore` (`*`), so a consuming repo needs no gitignore
  entry. When nx or git cannot answer, no sidecar is written and Impact is disabled with a
  one-line reason; generation never fails over it. `architecture:visualize` leaves the sidecar
  as it is.

The legend is generated per mode from the projects actually drawn, and the framework colors
are keyed off `KNOWN_FRAMEWORKS` (`@webpieces/rules-sdk`), the same list the framework-tag
validator checks.

### Compact graph filtering

Architecture and runtime node menus offer **Filter Unconnected** alongside
Lock/Unlock. Filtering retains the selected node and its separate transitive
incoming and outgoing chains, then reruns Graphviz. Architecture L-number rows keep
their original identities; runtime chains include rendered queues, clocks, external
APIs and systems. The anchor indicator and all surviving node menus offer **Turn off
Filter**, restoring the full layout and independent Lock state. Responsibilities
follow the retained set intersected with architecture Lock. Architecture Lock pins
its chain in the foreground; hover adds a temporary chain without dimming locked
nodes or edges, and leaving restores the Lock chain. The locked anchor keeps an amber outline,
and hover never changes responsibilities. A filtered-out Lock is suspended until
the full graph returns. Hover and menu dismissal
do not clear filtering, and no filter is persisted across reloads. Saved graph facts
and visibility options remain untouched. See
[dependency graphs](../../../docs/architecture/dependency-graphs.md#filter-unconnected)
for traversal examples and browser verification.
