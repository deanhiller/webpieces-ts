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
in a collapsible charcoal drawer on the left (violet accent): the **Color by** pulldown, the
**Filter** button, a type-to-search **Lock** field (`/` focuses it, `Esc` unlocks), a **Hide
unconnected** toggle, the legend (with a pop-out button) and the edge key. Help is the **?**
popover, zoom floats bottom-right, and **Responsibilities** opens a right-hand panel from the
drawer footer.

The graph answers one question at a time. Pick a mode from the drawer's **Color by** pulldown
(the one place to switch) or with keys `1` `2` `3` `4`; the choice is remembered per viewer and
deep-linkable as `#runtime`, `#architecture`, `#impact` or `#product`. Every box carries the same
three lines in every mode: `L3  name` (level dimmed, name bold), its role, and every framework tag.

Every row is one level. A library's level is its dependency depth, but every server, client and
app (`role:server` / `role:client` / `role:app`) is pinned to the TOP row, one above the highest
library, so the top row is exactly the entry points (a `role:bundle` sits above the apps it
aggregates; a server orchestrator above the servers it boots). The `level` in `dependencies.json`
is that promoted level. The runtime graph keeps its call-depth levels.

- **Runtime** — where the code can run. One runtime is a solid fill. One runtime plus a
  specialization (angular/react inside browser, express inside node) is nested: a frame in the
  base color around a rounded inner box in the specialization's color, which carries the text.
  Several runtimes are full-height vertical stripes in the fixed order browser | node |
  react-native, the text written across them (a specialization there shows in line 3 only). A
  box may depend on a box that carries every color it has.
- **Architecture** — servers · clients · APIs. A solid fill by role (server, client, app, bundle,
  api-lib, api-client, designed-lib, lib); framework color is not shown.
- **Impact** — what changed. There are two comparisons, both ending at the working tree (no
  `--head`, so uncommitted and untracked work counts, and the label says "+ uncommitted changes"):
  **Changed on this branch** (`nx show projects --affected --base=<fork point> --json`) and
  **Last commit** (`--base=HEAD^`, labelled with `HEAD`'s subject, so a squash commit's `(#NNNN)`
  names the PR). Which exist depends on where you are: on `main` (by branch name) and on a detached
  HEAD only *Last commit*; on a feature branch with commits of its own both, with a toggle
  (default *Changed on this branch*); on a fresh feature branch only *Changed on this branch*
  ("Nothing changed on this branch yet" while the tree is clean). To see what any commit changed,
  `git checkout <hash>` and run `pnpm arch:visualize`. `architecture:visualize` (no regenerate
  needed) scans every comparison that exists; `architecture:generate` refreshes only *Changed on
  this branch*, so on `main` it leaves Impact asking for `pnpm arch:visualize`. Projects that own a
  changed file, by nx's own file ownership, are solid amber ("changed"); the rest of the affected set is light amber
  ("dependent — tests and build re-run"); every transitive dependency of the affected set that is
  not itself affected is light slate with a dashed border ("dependency (built, unchanged)" — compiled
  or restored from cache); everything else is grey ("not in this build"). The drawer shows the counts per shade. The answer is per checkout, so
  it is written to `architecture/.impact/dependencies.impact.js`, never into the committed html or
  json. That directory holds its own `.gitignore` (`*`), so a consuming repo needs no gitignore
  entry. When nx or git cannot answer, no sidecar is written and Impact is disabled with a
  one-line reason; neither command fails over it. Impact state is never written on a box: color
  and legend only. When files changed but no project owns one (a lockfile, the workspace
  manifest), the legend names that workspace-global cause for the everything-affected result.

- **Product** — which products it belongs to. A project declares a product with the nx tag
  `product:<name>` (lowercase kebab, several allowed; the `product-tags` rule makes it required on
  servers, clients and apps). A library is never tagged: it belongs to every product whose tagged
  project reaches it over `dependsOn`, written per project as `"products": [...]` into
  `dependencies.json`. One product is a solid fill in that product's color (a fixed palette of 8 in
  sorted-name order; any product past 8 uses the neutral fill and the legend says so); two or more,
  but not all, are vertical stripes, one per product; a box shared by every product is one neutral
  fill; a box in no product is white with a dashed border. The legend counts each product's boxes
  and how many belong to it alone.

**Filter** opens a popover of four groups that INTERSECT: the changes of the active Impact
comparison, headed by its label and carrying the same branch / last-commit toggle (All ·
Changed · Changed + dependents (+ everything that uses them: their tests re-run) · Changed +
dependencies (+ everything they use) · Changed + dependents + dependencies (everything CI builds for
this branch — the dependencies of the dependents too, so it is more than the union of the two rows
above it), each with its project count; disabled with Impact's reason when there is no Impact
data), *Runtime* chips, *Role* chips and *Product* chips (a box matches a group when it carries any
selected chip; several products select the union of their closures; the Product group is hidden when
nothing declares a product). *Product* ∩ *Changed + dependents + dependencies* is exactly what this
branch builds that can affect that product. "Show N projects" applies it; active filters show as removable pills in the top bar and
a count badge on the drawer button. Every remaining box keeps its own L-row, a level left empty
is a thin labeled band, and edges between remaining boxes stay drawn.

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
nodes or edges, and leaving restores the Lock chain. The locked anchor keeps a violet outline,
and hover never changes responsibilities. A filtered-out Lock is suspended until
the full graph returns. Hover and menu dismissal
do not clear filtering, and no filter is persisted across reloads. Saved graph facts
and visibility options remain untouched. See
[dependency graphs](../../../docs/architecture/dependency-graphs.md#filter-unconnected)
for traversal examples and browser verification.

The runtime page also carries a **Product** chip row above the graph when any service belongs to a
product. A product's runtime services are its tagged services plus every service they reach over
runtime `dependsOn` (through a queue to its consumers too), so a call into another product's
service stays visible; queues, clocks and systems attached to a kept service stay with it. Several
chips keep the union, and the row intersects with Filter Unconnected. The page always opens
unfiltered. `runtime-dependencies.json` carries each service's `products`.
