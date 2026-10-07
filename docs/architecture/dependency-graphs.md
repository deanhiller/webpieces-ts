# Two Dependency Graphs: Compile-Time vs. Inferred Runtime

> Most projects have one dependency graph — what compiles against what. webpieces-ts has **two**,
> and the second one is the interesting part. It records, per API, whether a project **`implements`**
> it or **`uses`** it, then *infers* runtime call edges that do **not** exist at compile time —
> because a caller and its callee both only compile against the shared API *library*, never against
> each other. That inference is what lets the tooling draw a **potential runtime microservice call
> graph**, including pub-sub hops through a queue.

---

## The two files

### `architecture/dependencies.json` — compile-time + source of truth
Per-project it carries:
- `dependsOn` — the nx compile dependencies.
- `apiRelations` — per API class, a `"kind": "implements" | "uses"` with a transport `type`
  (`rpc` | `pubsub`). Example: `angular-site` **uses** `client-server-api`; `client-server`
  **implements** it. A `uses` also carries `targetService` when the call site named one —
  `createRpcClient(WarmupApi, new ClientConfig('helper-fsdb', ClientRole.SERVER))` → `"targetService": "helper-fsdb"`.
- A contract whose destination is not a module at all — the base URL arrives per call, from data —
  says so on the CONTRACT, with `@externalSystem runtime partner-webhooks`. That lands in
  `externalSystems` exactly as `@externalSystem saas twilio` does, and is drawn as an external system
  of kind `runtime` (its own shape), so the outbound hop appears on the graph rather than reading as
  a generic vendor box. On the contract rather than at a `createRpcClient` call site because it is
  true for every caller of that contract — one declaration however many services deliver over it.
- metadata: `role`, `framework`, `serviceName`, `responsibilitiesFile`, `designFile`, plus
  `aiInstructions` and `commands` to regenerate/visualize.

`serviceName` is the name **clients address this app by** at runtime, declared in its `project.json`:

```json
{ "metadata": { "webpieces": { "serviceName": "helper-fsdb" } } }
```

It is declared, never derived: the nx project name, the client-facing name and the deployed name are
three independent naming spaces (`helper-svr` serves `helper-portal`), so no strip-the-suffix rule
can compute one from another. Most projects declare none — a library or a browser app is never
addressed by name.

### `architecture/runtime-dependencies.json` — derived runtime call graph
Derived *solely* from `dependencies.json`. It distinguishes implements vs uses at the service and
API level:
- `services.<name>.implements[]` / `.uses[]` — e.g. `client-server` implements
  `[PublicApi, SaveApi, SecureApi]`, uses `[Server2Api]`; plus `serviceName` and `implementsVia`
  (api → the embedded library that serves it, when it is not the service's own source).
- `apis.<Name>.implementedBy[]` / `.usedBy[]` / `type` / `owner` (the api-lib holding the contract).
- `runtimeEdges[]`: `{ from, to, via: [apis], type }` — the **inferred** calls.

## The inference (why two graphs are needed)

`packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts`:

> "The runtime edge Z → X (Z depends on X at runtime) is INFERRED: Z `uses` api Y and X
> `implements` api Y. This edge does not exist in the compile-time dependencies.json (both Z and X
> only compile-depend on the api library Y)."

`buildEdges` walks each project's `usesApis`, looks up `apis.get(ref.api).implementedBy`, and emits
`from = user, to = implementer, via = api, type = ref.type`. A `uses` with no implementer becomes
`unresolvedUses` (a real diagnostic — someone calls an API nobody serves). Only `server`/`client`
apps are nodes; a library's relations are attributed transitively to the app that embeds it.

**Which implementer** is decided by the call site, not by "everyone who implements it". The `uses`
relation's `targetService` is matched against a runtime node — **its module name always, plus its
declared `serviceName` alias if it has one** — so exactly one edge is drawn. A module name can never
be shadowed by another module's alias; an alias that collides with one is reported as unreachable.

A name that matches **neither** is a build FAILURE (`validate-runtime-architecture`), because the
contract *is* served in-repo, so the name is a typo or a stale rename. This needs no allowlist for
third-party services: a call to something outside the repo has no in-repo implementer, so it lands
in `unresolvedUses` and never reaches the check. Where the deployed name differs from the module
name (an environment prefix like `tf-`), translate it once in `ClientRegistry.setDeriver` or with a
`serviceName` alias — never at the call site, which must keep naming something checkable. This matters most where the contract is most shared: a company-wide `WarmupApi`
registered once in a library is attributed (correctly) to *every* server, so a cross-product edge
would claim that every browser bundle calls every data server — and would manufacture cycles that
fail the build. When the target cannot be resolved (a non-literal client config, an undeclared
name), the old fan-out still happens, but `deriveRuntimeGraphReport(...).warnings` names the call
site and the executors print it: a wrong-but-green graph is worse than a failing one.

Crucially, **both** `architecture:generate` and `architecture:validate-runtime-architecture` call
the *same* `deriveRuntimeGraph`, so the committed graph and the validated graph can never diverge —
the graph is enforced, not just documentation.

## Visualization — `arch:visualize-runtime`

`packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` writes
`tmp/webpieces/runtime-architecture.{dot,html}` (viz.js). Notable rendering rules:
- A node's role is derived from implements vs uses: `role = svc.implements.length > 0 ? 'server' : 'client'`.
- Each node **lists the contracts it implements and uses** (with `(via <lib>)` when it serves one
  through an embedded library), so an api a service serves that nothing in-repo calls is still
  visible — you no longer have to read it off an incoming edge.
- A contract nothing in-repo implements (firestore, gmail, ...) is drawn as a **dashed terminal
  node** grouped by its owning api-lib, from the `unresolvedUses` data. It is render-only: levels,
  cycle detection and the JSON are unaffected. Turn it off with
  `runtime-architecture.showExternalNodes: false` in `webpieces.config.json`.
- `rpc` edges → a direct labeled arrow.
- `pubsub` edges → producer → **queue cylinder** → consumer, with dashed `enqueue` / `deliver`
  arrows. The legend: "the producer enqueues a Cloud Task and the consumer is delivered it later."

So the picture literally shows the [one-contract-many-transports](./one-contract-many-transports.md)
pub-sub path as a producer, a queue, and a consumer — the visual twin of the propagation-through-a-
queue story in [context-propagation](./context-propagation.md).

## The other graph: per-process DI DAG

Distinct from the microservice runtime graph, there is a **per-project dependency-injection graph**
(`design.json`) built by `packages/tooling/nx-webpieces-rules/src/lib/di-graph/analyzer.ts`. It
walks constructor injection through the **TypeScript compiler API** from a project's root classes
down to leaves:

> "@inject(TOKEN) params → token lookup in the binding table → bound impl; @multiInject(TOKEN) →
> fan-out edge to EVERY binding of that token; bare typed params → checker resolves the type to a
> class (inject-by-type); toConstantValue/toDynamicValue → leaf nodes."

Edge and node types (`di-graph/model.ts`):
- `DiEdge`: `{ from, to, injection: 'token' | 'type' | 'multiInject', token, paramName, paramType }`
  — an "injects/uses" edge, tagged by the injection mechanism.
- `DiNode.api`: "The declared API/interface type this class was injected AS, when it differs from
  the impl class name — e.g. injected `FirestoreAdminApi`, resolved `.to(FirestoreAdminClient)`."
  This captures the **implements-as** resolution *within* a process: which concrete impl the
  container will hand you for an injected interface. Renderers show the interface as the primary box
  label with the impl `className` in parens beneath.
- The walk **stops** at an API boundary (`Binding.isApiBoundary` flags `createApiClient(SomeApi,…)`
  proxies) — "the remote impl lives in another process." That boundary is exactly where the
  *runtime* graph above picks the trail back up.

So the two DI-aware graphs compose: `analyzer.ts` resolves implements-vs-uses **inside** a process
(down to the network boundary), and `runtime-graph.ts` resolves implements-vs-uses **across**
processes (which service serves the API another service calls).

---

## Why this is advanced
- **It models what actually happens at runtime, not just what links at compile time.** The
  inferred `Z → X` edges are invisible to any normal build-graph tool.
- **It is derived and validated from one source**, so the diagram can't rot.
- **It understands the framework's own idioms** — inject-by-type, multiInject fan-out,
  `createApiClient` network boundaries, and pub-sub queues — because it walks the TS AST and the
  Inversify binding table, not a hand-maintained list.

### Source map
| Concern | File |
|---|---|
| Compile graph (source of truth) | `architecture/dependencies.json` |
| Inferred runtime graph | `architecture/runtime-dependencies.json` |
| Runtime derivation | `nx-webpieces-rules/src/lib/runtime-graph.ts` |
| Runtime visualization | `nx-webpieces-rules/src/lib/runtime-visualizer.ts`, `executors/visualize-runtime/` |
| Per-process DI DAG | `nx-webpieces-rules/src/lib/di-graph/analyzer.ts`, `model.ts` |
| Compile-graph visualization | `nx-webpieces-rules/src/lib/graph-visualizer.ts` |
| Commands | `pnpm arch:generate`, `pnpm arch:visualize`, `pnpm arch:visualize-runtime` |

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

## Filter Unconnected

Both saved architecture pages offer **Filter Unconnected** in a node's floating
menu. It retains that node, all transitive incoming ancestors, and all transitive
outgoing dependencies, walking each direction separately. For `A → shared ← B`,
filtering A keeps A and shared; filtering shared keeps all three. Runtime filtering
follows the rendered topology, including queues, triggers, datastores and external
systems. Hidden nodes never act as bridges.

The page reruns Graphviz on the retained nodes and their original edges. Architecture
projects keep their original L-number rows, highest first and L0 last; empty bands
and unnecessary spacers disappear. The filter changes presentation only and never
rewrites saved JSON or runtime visibility settings.

A page has one active filter. Every surviving node menu and the visible indicator
naming the anchor offer **Turn off Filter**. Turn it off before choosing another
anchor. Hover, Escape and outside clicks leave filtering active. Lock is independent:
architecture Lock pins its full chain in the foreground. Hover adds its own chain
temporarily without dimming any locked node or edge; leaving removes only that
temporary highlight. The locked box keeps a violet outline while hovering another box.
Lock filters responsibilities to
the intersection with the retained nodes; runtime Lock still focuses one box. A
locked node hidden by filtering keeps its selection without dimming the whole graph.
Clearing the filter restores the original full layout and Lock. Reloading clears
both controls. Rendering failures leave the previous graph usable and show a recovery
message.

The optional browser regression suite uses the pages' pinned Viz UMD renderer and
installed Playwright Chromium. Set `WP_GRAPH_VIZ_JS` to that renderer's local path
(and `PLAYWRIGHT_BROWSERS_PATH` when necessary), then run the focused
`graph-filter-browser.spec.ts`. It opens generated pages as local files and writes
before/filter/restored screenshots under `.webpieces/1118-browser-evidence/`.

Drawable nodes are keyboard reachable with Tab. Enter or Space opens the node menu,
with focus on its first action. Escape returns keyboard focus to the invoking node;
keyboard actions retain that node by name across a filter redraw, or focus the first
surviving node when it is removed. Outside clicks keep focus on their clicked target.
Keyboard focus uses a thin dashed violet outline that stays dim with an unrelated
node. It is separate from blue hover, amber Lock, and the filter anchor. Pointer menu
opening and dismissal do not leave a node focus outline.
