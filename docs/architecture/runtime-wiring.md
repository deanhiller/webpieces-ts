# Reviewed runtime wiring

Runtime topology belongs in each participating project's `src/wiring.ts`. Tag applications
`webpieces` and libraries with exported wiring `webpieces-lib`. Imports establish source dependencies;
only exports selected by an application's plan establish runtime relationships.

`rpcTarget(Api, deployment)` is the sole public target constructor; `RpcTarget<T>` is exported as a type. RPC bindings require this descriptor.

Node plans return `new ServerWiring(host, new ServerWiringOptions(bindingModules, routingModules))`.
Binding modules are Inversify ContainerModules; routing modules are RouteModules. Keep them separate.
Browser plans return `new BrowserWiring(providers)` and applications install `toProviders()` through
Angular's existing application configuration. The browser package imports neither Angular nor Node.

Use `RuntimeClients.bindRpc(token, Api, rpcTarget(Api, deployment))` inside binding modules and
`provideRpcClient(token, Api, rpcTarget(Api, deployment))` in browser provider lists. These factories
remain lazy and preserve the token that tests override. A deployment identity selects a service;
URLs, environment configuration, context stores, authentication and credentials remain runtime data.
`ClientToken<T>` offers optional invariant typed Node tokens; raw symbols remain supported.
`RuntimeTaskClients.bindPubSub(token, Api, deployment)` supplies lazy singleton Cloud Tasks clients.
Raw factory APIs remain the implementation primitives for integrations. Supported hand-written
singleton DI factories and browser providers are rejected, including inside canonical `wiring.ts`.
This is an ALL-CODE grammar check: architecture validation scans every participating runtime owner,
including unchanged projects outside the current diff, and reports all supported occurrences together.
Use `new RuntimeClients(options)` once per module and preserve tokens, API, target and optional RPC
filters in each `bindRpc` call. Pub/sub and browser helpers have no filter argument; registrations
with unsupported options, transient scope or additional callback work remain low-level integrations.
The per-owner source proof checks the same grammar before producing candidates. The generated
architecture instructions and rule catalog contain these helper migration steps.

## Schema version 1

Each project approves a `runtime-deps.json` with these fields:

- `schemaVersion`: exactly 1.
- `project`: the Nx owning project name.
- `framework`: `node`, `angular`, or `browser`.
- `exports`: map of exported source symbols to wiring declarations.
- `entry`: the application's exported plan class; absent for libraries.
- `host`: Node deployment identity, matching project metadata `serviceName`.

Each export has `kind` (`binding`, `routing`, `providers`, `plan`, or `external`),
`relationships`, and `selections`. Each relationship identifies its canonical contract as
`{project, exportedName}`, its `direction` (`implements` or `uses`), and its `transport`
(`rpc`, `pubsub`, or `external`). Uses include a target: a literal `service` identity,
a named `parameter`, an `external` system, or an explicit `unknown` reason.
Typed service targets also carry their contract capability identity.

Each selection names `project` and `exportedName`, supplies a `targets` map, and supplies a
`policies` map. Library arguments are substituted per selection; two selections can bind the
same API to different deployments. Unselected library exports contribute no relationships.
Missing declarations, exports, targets, policies, invalid capability identities and composition
cycles fail before graph output is written. Unknown schema fields are rejected.

Topology conditions use an explicit `WiringPolicy` parameter and `if (policy.enabled)`.
Pass `new WiringPolicy(name, expression)` at composition. Literal booleans resolve to an enabled
or disabled selection; environment expressions stay `runtime` and retain conditional provenance.
Extraction never evaluates the environment. Nested conditions, else branches, switches and loops
fail explicitly; express these as separate selected modules rather than losing conditions.

Vendor interfaces remain interfaces. A selected module can declare
`new ExternalContractUse('vendor-project#VendorApi')` alongside ordinary SDK bindings. This is
metadata, not an RPC factory. Production constructor dependencies must establish a real business
consumer of the interface. Implementations and test doubles alone do not establish uses. Existing
approved external-system contract metadata and project tags determine vendor system identity.

## Build proof and review

Tagged projects require an explicit `build.options.outputPath`. The inferred
`runtime-wiring-check` runs before build and in CI, writes only
`<outputPath>/runtime-deps.candidate.json`, and compares it with the approved project file.
A mismatch prints the approval path, candidate path and diff. Review the candidate and copy it
explicitly after checking the source change; extraction never updates an approval.

Nx caches successful proofs using project/import inputs, the approval, configuration, schema/tool
source and installed tooling version. API/DTO source correctness remains a separate build check:
`validate-api-lib-tag` extracts contract evidence and writes API contract candidates under each
owner's configured build output. Review contract changes into `architecture/apis` and update saved
contract references explicitly. Graph generation reads the approved contracts and wiring only;
it never creates TypeScript programs or silently falls back to workspace runtime scanning.

## Bootstrap without saved metadata

Run the owning API source check to emit candidates even when no saved graph exists. Review and copy
contract candidates into `architecture/apis/<ApiName>.json`, and review the emitted external-system
table. Create `architecture/dependencies.json` with `projects: {}`, an `apiContractFiles` map from each
API name to `apis/<ApiName>.json`, and the reviewed `externalSystems` table. Review each tagged
owner's wiring candidate into `runtime-deps.json` before generation. Generation can then assemble
these approvals and produce the project/dependency/runtime views for a final architecture review.

For older saved files containing `apiContracts`, explicitly move each existing value into its
per-contract file and replace the old key with reviewed `apiContractFiles` references, preserving
external systems. Generation never migrates or approves contract source on the caller's behalf.

## Release and migration

Publish declaration tooling and client helpers first. Upgrade the producer's installed catalog to
that release before switching its applications, approving per-project declarations and generating
architecture. Consumers then upgrade their installed tooling and migrate all saved runtime owners
in one reviewed change. Declaration-only generation fails clearly on unmigrated owners; this failure
does not prevent rendering committed snapshots with `visualize` or `visualize-runtime`.

Keep existing dependency, authentication, filter, URL, context and test override behavior while
moving route/client construction to canonical wiring. Compare the generated runtime graph against
the last approved snapshot. Review removed false import-only relationships explicitly. Record cold,
warm and changed-project build timings separately from declaration-only generation timings.

Both HTML graphs default to readable scale with contained scrolling. Fit is explicit; Readable
resets zoom. Runtime nodes show Implements/Uses counts; hover, focus or click opens full qualified
facts and provenance. Edges keep one or two API names inline; larger sets open a Uses dropdown.
Hidden external destinations remain in node details and queue producer inference is labeled.
