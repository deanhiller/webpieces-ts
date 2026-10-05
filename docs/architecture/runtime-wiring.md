# Reviewed runtime wiring

Runtime topology belongs in each participating project's `src/wiring.ts`. Tag applications
`webpieces` and libraries with exported wiring `webpieces-lib`. Imports establish source dependencies;
only exports selected by an application's plan establish runtime relationships.

Node and browser use the same roles. `Wiring` exposes `getBindingModules()` and
`getRoutingModules()`. `AppWiring` adds `getWirings()` for one level of library composition;
Node also retains `getHeaders()`. Import the concrete interfaces from `@webpieces/http-routing`
or `@webpieces/http-client-browser`. The shared core contains only platform-neutral topology.

Each selection getter returns a literal array of named instances:

```ts
getWirings(): Wiring[] { return [new AuthWiring(this.config)]; }
getBindingModules(): BindingModule[] { return [new ApplicationBindings()]; }
getRoutingModules(): RouteModule[] { return [new ApplicationRoutes()]; }
```

Getters contain no spreads, helpers, nested arrays, casts, or setup. Constructors store prepared
inputs using parameter properties. Only an application can select libraries.

## wiring.ts shows the actual wiring

Each owner's `src/wiring.ts` contains its exported Wiring or AppWiring class AND the named
BindingModule and RouteModule classes it selects, above or below it, with their real registrations
in `configure`: `RuntimeClients.bindRpc`, `provideRpcClient`, `RuntimeTaskClients.bindPubSub`,
`router.addRoutes`, `router.addFilter`, DI binds and provider recipes. A selection must resolve
(through the compiler, never by name) to a module class declared in the SAME file, and a library
Wiring selected by `getWirings()` must be declared in that library's own `src/wiring.ts`, where its
modules and registrations live. Importing a module implementation from `RuntimeModules.ts`,
`BrowserSetup.ts` or any other file fails with a diagnostic naming the module and its file, and so
does inheriting a selection getter or `configure` from another file.

```ts
export class ProductRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addRoutes(ProjectsApi, ProjectsController);
    }
}

export class RemoteStoreBindings implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void {
        new RuntimeClients(options).bindRpc(STORE_TYPES.StoreApi, StoreApi, 'store');
        options.bind(JWT_HOOK).to(CompanyJwtHook).inSingletonScope();
        options.bind(WARMUP).toDynamicValue((ctx: ResolutionContext) => ctx.get(STORE_TYPES.StoreApi)).inSingletonScope();
    }
}

export class ProductAppWiring implements AppWiring {
    constructor(private readonly config: ProductConfig) {}
    getWirings(): Wiring[] { return [new AuthWiring(this.config.auth)]; }
    getBindingModules(): BindingModule[] { return [new RemoteStoreBindings()]; }
    getRoutingModules(): RouteModule[] { return [new ProductRoutes()]; }
}
```

Business and preparation work stays OUT of wiring.ts: configuration building, translations,
environment discovery, event subscriptions, initializer bodies, controller/service logic and named
factory implementations. wiring.ts keeps the registration visible and references them by name:
`provideAppInitializer(initializeSession)`, `{ provide: TOKEN, useFactory: chrome, deps: [Text] }`,
`toDynamicValue(AppSecrets.fromEnvironment)`. A `configure` contains only registration declarations:
`options.bind(...)` chains (`to`, `toSelf`, `toConstantValue`, `toDynamicValue`, `inSingletonScope`),
short DI factory callbacks such as `(ctx) => ctx.get(Token)`, client bindings, `bindings.add(...)`
provider recipes (`makeEnvironmentProviders`, `provide`/`useClass`/`useExisting`/`useFactory`/
`useValue`/`deps`/`multi`, `provideRouter`, ...), routes, filters, `(await) Module.load(options)`
for an opaque vendor or library module, `new ExternalContractUse(...)` and named `WiringPolicy`
conditions. Loops, non-policy branches, block-bodied callbacks, environment reads, computed
configuration and calls into this owner's own helpers (which would hide the registrations they
return) are rejected. A loaded module's implementation is never scanned for topology: an owner's
API clients and controllers are explicit in its wiring.ts.

`wiring-format` checks every tagged owner's canonical `src/wiring.ts`, including unchanged owners,
and never format-checks any other file. Its explicit `maxLines` configuration (the agreed limit is
400) is a backstop behind the grammar: a complete, normally formatted lang-sized server with 25
client/task/controller declarations measures about 265 lines. When a file outgrows it, move
business logic out or give a cohesive group its own library owner and wiring.ts; never move an
owner's modules or registrations into another file.

Runtime extraction reads ONLY canonical wiring.ts files. The compiler still type-checks the whole
project, so imported and re-exported APIs, tokens, controllers and prepared configuration resolve to
their qualified identities, but no other file's body is visited for wiring facts and there is no
fallback discovery. Separately, an `ExternalContractUse` is still backed by a production business
consumer found among the owner's constructor dependencies; that consumer proof adds no relationship.

Node binding modules implement `configure(options: ContainerModuleLoadOptions)`; asynchronous
configuration is awaited. Route modules implement `configure(router: WebpiecesRouter)`.
Use `new RuntimeClients(options).bindRpc(token, Api, 'deployment')` or
`RuntimeTaskClients.bindPubSub(token, Api, 'deployment')`. Destinations are strings; `rpcTarget`
and `RpcTarget` have been removed. API/token typing, singleton scope, filters and test tokens remain.
Low-level factory bodies belong in imported implementations; their registrations stay in wiring.ts.

Browser modules configure a `BrowserBindings` collector. `bindings.add(provideRpcClient(token,
Api, 'deployment'))` remains lazy. `BrowserWiringProviders.toProviders(app)` installs the collected
providers through Angular's application configuration. Named BrowserValueProvider,
BrowserFactoryProvider, BrowserClassProvider and BrowserExistingProvider recipes preserve provider
and dependency identities without importing Angular or Node into the browser package.

The runtime materializes each selected instance's lists once. It runs application bindings then
library bindings in list order, followed by application routes then library routes. Repeated
selections are retained. Node test override modules still load last, before route configuration.
Company-owned config, context, authentication, errors and URLs remain outside framework topology.

## Schema version 2

Each project explicitly approves a `runtime-deps.json` containing:

- `schemaVersion`: exactly 2; older versions fail with migration instructions.
- `project` and `framework`: the Nx owner and `node`, `angular`, or `browser`.
- `exports`: map of resolved named exports, with `kind` of `app`, `wiring`, `binding`, `routing`, or `external`.
- `entry`: exactly one app export for applications; absent for libraries.
- `host`: Node app deployment identity from project metadata; absent for libraries.

Each export has `relationships`, `bindingModules`, `routingModules` and `wirings`. Only an app
may populate `wirings`; leaves contain facts rather than selections. The two module channels are
validated independently. Each relationship identifies its canonical contract as
`{project, exportedName}`, direction (`implements` or `uses`), and transport (`rpc`, `pubsub`,
or `external`). Uses include a target: a service identity, forwarded named parameter, external
system, or explicit unknown reason. Graph-relevant prepared constructor paths are inferred from
actual declarations, including nested config fields; unused config and credentials are omitted.
Extraction resolves imports, aliases and inherited methods without running application code.

Each selection names `project` and `exportedName`, supplies a `targets` map, and supplies a
`policies` map. Library arguments are substituted per selection; two selections can bind the
same API to different deployments. Unselected library exports contribute no relationships.
Missing declarations, exports, targets, policies, invalid capability identities and unsupported app/library nesting fail before graph output is written. Unknown schema fields are rejected.

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

Publish the compatible declaration tooling and runtime family first. Upgrade the producer's installed catalog to
that release before enabling the new public rule configuration, approving per-project declarations and generating
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

The producer uses the published 0.4.866 tooling family, whose `wiring-format` policy runs
`RUN_EVERY_TIME`; canonical source proof and approved graph generation use the installed executors.
No source-preview override is required. The canonical-only extraction, same-file module rule and
400-line recommendation of issue #1146 ship in source first; the producer's explicit `maxLines`
value moves to 400 with the pin bump to the release that carries them.
