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
  **implements** it.
- metadata: `role`, `framework`, `responsibilitiesFile`, `designFile`, plus `aiInstructions` and
  `commands` to regenerate/visualize.

### `architecture/runtime-dependencies.json` — derived runtime call graph
Derived *solely* from `dependencies.json`. It distinguishes implements vs uses at the service and
API level:
- `services.<name>.implements[]` / `.uses[]` — e.g. `client-server` implements
  `[PublicApi, SaveApi, SecureApi]`, uses `[Server2Api]`.
- `apis.<Name>.implementedBy[]` / `.usedBy[]` / `type`.
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

Crucially, **both** `architecture:generate` and `architecture:validate-runtime-architecture` call
the *same* `deriveRuntimeGraph`, so the committed graph and the validated graph can never diverge —
the graph is enforced, not just documentation.

## Visualization — `arch:visualize-runtime`

`packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` writes
`tmp/webpieces/runtime-architecture.{dot,html}` (viz.js). Notable rendering rules:
- A node's role is derived from implements vs uses: `role = svc.implements.length > 0 ? 'server' : 'client'`.
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
