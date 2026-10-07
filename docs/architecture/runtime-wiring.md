# Reviewed runtime wiring

Runtime topology belongs in each participating project's `src/wiring.ts`. Tag applications
`webpieces` and libraries with exported wiring `webpieces-lib`. Imports establish source dependencies;
only exports selected by an application's plan establish runtime relationships.

Node and browser use the same roles. A `BindModule` binds DI for every host; the generic
`BindModule<B>` lives in `@webpieces/http-client-core` and each host re-exports a non-generic alias
whose `configure(binder: Binder)` receives that host's binder. `Wiring` exposes `getBindModules()`.
A Node `Wiring` adds `getRouteModules()`: `RouteModule` (api -> controller routes) is Node-only, and
a browser wiring has no route channel. `AppWiring` adds `getWirings()` for one level of library
composition; Node also retains `getHeaders()`. Import the concrete interfaces from
`@webpieces/http-routing` or `@webpieces/http-client-browser`. (#1150 renamed `BindingModule` to
`BindModule` and the getters to `getBindModules()` / `getRouteModules()`.)

Each selection getter returns a literal array of named instances:

```ts
getWirings(): Wiring[] { return [new AuthWiring(this.config)]; }
getBindModules(): BindModule[] { return [new ApplicationBindings(), new GcpTtsBindModule(this.config.tts)]; }
getRouteModules(): RouteModule[] { return [new ApplicationRoutes()]; }
```

Getters contain no spreads, helpers, nested arrays, casts, or setup. Constructors store prepared
inputs using parameter properties. Only an application can select libraries.

## wiring.ts shows the actual wiring

Each owner's `src/wiring.ts` contains its exported Wiring or AppWiring class AND the named
BindModule and RouteModule classes it selects, above or below it, with their real registrations
in `configure`: `binder.createRpcClientAndBind`, `binder.createPubSubClientAndBind`,
`binder.bindExternal`, `binder.bind` chains, browser `binder.provide` recipes, `router.addRoutes`
and `router.addFilter`.

The rule is OWNER-canonical. A selection must resolve (through the compiler, by symbol identity,
never by name) to a module class declared in its owner's canonical `src/wiring.ts`: the selecting
owner's own file, or, for a BindModule an AppWiring selects, a library owner's canonical
`src/wiring.ts`. A re-export resolves to its true declaration, so `export { GcpTtsBindModule } from
'./wiring'` in a library barrel is fine. A library Wiring selected by `getWirings()` must likewise
be declared in that library's own `src/wiring.ts`. A library's canonical wiring.ts may export only
BindModules, with no Wiring class, so an app selects a vendor module in one line. Selecting a class
declared in `RuntimeModules.ts`, `BrowserSetup.ts` or any other file, or a `ContainerModule`, fails
with a diagnostic naming the module and its file, and so does inheriting a selection getter or
`configure` from another file. Only an AppWiring selects another owner's BindModule.

```ts
export class ProductRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addRoutes(ProjectsApi, ProjectsController);
    }
}

export class RemoteStoreBindModule implements BindModule {
    configure(binder: Binder): void {
        binder.createRpcClientAndBind(StoreApi, 'store');
        binder.bind(JWT_HOOK).to(CompanyJwtHook).inSingletonScope();
        binder.bind(WARMUP).toDynamicValue((ctx: ResolutionContext) => ctx.get(StoreApi)).inSingletonScope();
    }
}

export class ProductAppWiring implements AppWiring {
    constructor(private readonly config: ProductConfig) {}
    getWirings(): Wiring[] { return [new AuthWiring(this.config.auth)]; }
    getBindModules(): BindModule[] {
        return [new RemoteStoreBindModule(), new GcpTtsBindModule(this.config.tts)];
    }
    getRouteModules(): RouteModule[] { return [new ProductRoutes()]; }
}

// libraries/apis/external-node/gcp-tts/src/wiring.ts - a library canonical file of BindModules only
export class GcpTtsBindModule implements BindModule {
    constructor(private readonly config: TextToSpeechConfigDto) {}
    configure(binder: Binder): void {
        binder.bind(GCP_TTS_TYPES.TextToSpeechConfigDto).toConstantValue(this.config);
        binder.bindExternal(TextToSpeechApi, GcpTextToSpeechClient);
    }
}
```

Before #1150 the same lang-server module read
`new RuntimeClients(options).bindRpc(LANG_FSDB_TYPES.LangFsdbApi, LangFsdbApi, 'lang-fsdb')`, every
vendor `ContainerModule` needed a per-app wrapper whose `configure` called `.load(options)`, and the
external edge was a side-effect-free `new ExternalContractUse('lib-gcp-tts#TextToSpeechApi')`. Now
the same facts are one `binder.*` call each:

```ts
export class RemoteFsdbBindModule implements BindModule {
    configure(binder: Binder): void {
        binder.createRpcClientAndBind(LangFsdbApi, 'lang-fsdb');
        binder.createRpcClientAndBind(AuthStoreApi, 'lang-fsdb');
        binder.bind(WARMUP_TYPES.DownstreamWarmup)
            .toDynamicValue((ctx: ResolutionContext) => ctx.get(AuthStoreApi))
            .inSingletonScope();
    }
}

export class AppBindModule implements BindModule {
    constructor(private readonly webApp: WebAppConfig, private readonly offline: OfflineConfig) {}
    configure(binder: Binder): void {
        binder.bind(WebAppConfig).toConstantValue(this.webApp);
        binder.bind(OfflineConfig).toConstantValue(this.offline);
        binder.createPubSubClientAndBind(LangReusableTtsAudioApi, 'lang');
    }
}
```

Business and preparation work stays OUT of wiring.ts: configuration building, translations,
environment discovery, event subscriptions, initializer bodies, controller/service logic and named
factory implementations. wiring.ts keeps the registration visible and references them by name:
`provideAppInitializer(initializeSession)`, `{ provide: TOKEN, useFactory: chrome, deps: [Text] }`,
`toDynamicValue(AppSecrets.fromEnvironment)`. A `configure` contains only registration declarations:
`binder.bind(...)` chains (`to`, `toSelf`, `toConstantValue`, `toDynamicValue`, `inSingletonScope`),
short DI factory callbacks such as `(ctx) => ctx.get(Token)`, `binder.createRpcClientAndBind`,
`binder.createPubSubClientAndBind`, `binder.bindExternal`, browser `binder.provide(...)` recipes
(`makeEnvironmentProviders`, `provide`/`useClass`/`useExisting`/`useFactory`/`useValue`/`deps`/`multi`,
`provideRouter`, ...), routes, filters and named `WiringPolicy` conditions. Loops, non-policy
branches, block-bodied callbacks, environment reads, computed configuration and calls into this
owner's own helpers (which would hide the registrations they return) are rejected. An opaque
`Module.load(...)` is no longer a registration: give a vendor its own library BindModule in that
library's canonical wiring.ts. The retired helpers `RuntimeClients`, `RuntimeTaskClients`,
`provideRpcClient`, `ExternalContractUse` and `BrowserBindings` are deleted, and a canonical file
naming them is rejected with the binder form to use instead.

`wiring-format` checks every tagged owner's canonical `src/wiring.ts`, including unchanged owners,
and never format-checks any other file. Its explicit `maxLines` configuration (the agreed limit is
400) is a backstop behind the grammar: a complete, normally formatted lang-sized server with 25
client/task/controller declarations measures about 265 lines. When a file outgrows it, move
business logic out or give a cohesive group its own library owner and wiring.ts; never move an
owner's modules or registrations into another file.

Runtime extraction reads ONLY canonical wiring.ts files. The compiler still type-checks the whole
project, so imported and re-exported APIs, tokens, controllers and prepared configuration resolve to
their qualified identities, but no other file's body is visited for wiring facts and there is no
fallback discovery. A library BindModule an app selects is read from that library's canonical
wiring.ts, through the library's own approved declaration. Separately, `binder.bindExternal` in an
APPLICATION's module is still backed by a production business consumer found among the app's
constructor dependencies; a library module binds an adapter for whichever app selects it, so its
consumer lives in that app. That consumer proof adds no relationship.

Node bind modules implement `configure(binder: Binder)`; asynchronous configuration is awaited.
Route modules implement `configure(router: WebpiecesRouter)`. The Node `Binder`
(`@webpieces/http-routing`) offers:

- `bind(token)` — plain Inversify fluent syntax.
- `createRpcClientAndBind(Api, 'deployment', options?)` — registers
  `toDynamicValue(ctx => ctx.get(ClientHttpFactory).createRpcClient(Api, new ClientConfig(deployment, ClientRole.SERVER), filters))`
  in singleton scope, so the client resolves lazily from the already-bound factory.
- `createPubSubClientAndBind(Api, 'deployment', options?)` — the same over `ClientCloudTasksFactory`.
- `bindExternal(Api, VendorImpl)` — binds the vendor implementation to its external contract and
  records the external-contract graph edge in one statement.

The token defaults to the API class itself (contracts are abstract classes, valid DI tokens).
`new ClientBindOptions<T>(token?, filters?)` supplies an extra token only when two clients of the
same API must coexist (for example one per deployment), plus RPC outbound filters;
`new PubSubBindOptions<T>(token?)` carries the token for a Cloud Tasks client. Destinations are
strings; factories are bound once by the framework and never passed through a module constructor.
Low-level factory bodies belong in imported implementations; their registrations stay in wiring.ts.

Browser modules configure the browser `Binder` (`@webpieces/http-client-browser`):
`binder.createRpcClientAndBind(Api, 'deployment', new ClientBindOptions<T>(token?))` registers a
lazy factory provider with deps `[ClientHttpBrowserFactory, ClientConfig]`, and
`binder.provide(...recipes)` adds provider recipes, including Angular router providers, and
`binder.bindExternal(Api, new UseClass(Vendor))` /
`binder.bindExternal(Api, new UseExisting(Token))` registers a vendor implementation of an
external contract (#1153) — the contract constructed as `Vendor`, or aliased to the already-provided
`Token` — AND records the same external `uses` edge as the Node call. Both a constructed vendor and
an existing token are classes at runtime, so the recipe is named by the class carrying it
(`UseClass` / `UseExisting`, both `ExternalImpl` subclasses) rather than guessed from the argument;
a bare class does not compile.
`BrowserWiringProviders.toProviders(app)` installs the collected providers through Angular's
application configuration. Named BrowserValueProvider, BrowserFactoryProvider, BrowserClassProvider
and BrowserExistingProvider recipes preserve provider and dependency identities without importing
Angular or Node into the browser package.

The runtime materializes each selected instance's lists once. It runs application bind modules then
library bind modules in list order, followed (on Node) by application routes then library routes. Repeated
selections are retained. Node test override modules still load last, before route configuration.
Company-owned config, context, authentication, errors and URLs remain outside framework topology.

## Schema version 2

Each project explicitly approves a `runtime-deps.json` containing:

- `schemaVersion`: exactly 2; older versions fail with migration instructions.
- `project` and `framework`: the Nx owner and `node`, `angular`, or `browser`.
- `exports`: map of resolved named exports, with `kind` of `app`, `wiring`, `binding`, `routing`, or `external`.
- `entry`: exactly one app export for applications; absent for libraries.
- `host`: Node app deployment identity from project metadata; absent for libraries.

Each export has `relationships`, `bindModules`, `routeModules` and `wirings` (a browser export's
`routeModules` is always empty). The pre-#1150 field names `bindingModules` / `routingModules` are
rejected with an error naming the new field. Only an app may populate `wirings`; leaves contain
facts rather than selections. The two module channels are validated independently. Each relationship identifies its canonical contract as
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

A vendor contract is bound with `binder.bindExternal(VendorApi, VendorClient)` (browser:
`binder.bindExternal(VendorApi, new UseClass(VendorClient))` or `new UseExisting(Token)`), alongside ordinary
SDK bindings, usually in the vendor library's own canonical wiring.ts. The contract is an abstract
class, so its identity resolves by symbol like any other API, and the call records the same
external `uses` edge `ExternalContractUse` used to. In an application's own module, production
constructor dependencies must establish a real business consumer of the contract; implementations
and test doubles alone do not establish uses. Existing approved external-system contract metadata
and project tags determine vendor system identity.

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
value moves to 400 with the pin bump to the release that carries them. The #1150 BindModule/Binder
surface, the OWNER-canonical rule and the `bindModules`/`routeModules` fields likewise ship in
source first; until the release carrying them is pinned, this repo runs the wiring executors from
source.
