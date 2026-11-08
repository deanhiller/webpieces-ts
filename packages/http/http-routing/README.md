# @webpieces/http-routing

> Decorator-based routing with auto-wiring for WebPieces

Part of the [WebPieces TypeScript](https://github.com/deanhiller/webpieces-ts) framework.

## Installation

```bash
npm install @webpieces/http-routing
```

## OIDC on private Cloud Run

`@WpAuth([oidcSameProject()])` and `@WpAuth([oidcSvcs([...])])` select client-side Google
ID-token generation. With invocation authentication and invoker IAM enabled, Cloud Run checks the
invocation before it reaches `AuthFilter`; the framework then checks the caller itself.
`oidcSameProject()` admits any service account of this service's GCP project (open off GCP, where
there is no project), and `oidcSvcs([...])` only the listed accounts, which may belong to other
projects; an endpoint may pair the two, and the token is then verified once against both. A bound
`OidcHook` receives all of the endpoint's OIDC methods (`OidcAuthMethods`). Local tokens exercise
the filter chain without proving deployed IAM or Google signature validation.
See [the Cloud Run OIDC security boundary](../../../docs/architecture/cloud-run-oidc.md) for the
current verifier behavior and the assumptions required for that deployment model.

## Startup timing observer

`RuntimeSetupOptions` accepts an optional `startupObserver` after `config`. A host implementing
`RuntimeStartupObserver.start(operation)` returns a `RuntimeStartupSpan` with `success()` and
`failure()` methods. The host owns its monotonic clock, aggregation and output; the framework imports
no telemetry SDK and reads no timing clock when no observer is supplied. Direct router factory users
can supply the same observer through `WebpiecesRouterOptions.startupObserver`.

Operations identify header/logging setup, wiring discovery, framework/application DI module loading,
application binding configuration, fixed filters, filter resolution, route groups, API route registration
and controller resolution. Names are code identities, never config values or request data. Binding
configuration is awaited, including asynchronous modules. The normal API invocation path produces no
startup events.

Times are **inclusive**: route registration includes its controller/dependency resolutions, and container
creation includes binding/filter setup. Do not sum nested intervals. Repeated `controller-resolution`
operations can return the same cached singleton; they are not counts of new constructors. The observer
should aggregate bounded slowest groups, retain failure/incomplete spans, and distinguish this work from
Node module imports that occurred before runtime setup.

Diagnostics do not change eager/lazy behavior. Routes still resolve controllers during registration and
validate authentication/authorization at startup. No request context or second dispatcher is introduced.
An observer that throws is disabled for that timing boundary after a bootstrap warning; observer failures
cannot replace the application result or its original thrown startup error. Application failures retain
nonzero/failure handling at the host's existing startup boundary. Keep observer callbacks small and
nonthrowing; JavaScript startup observation runs synchronously in the operation's process, unlike a
separate tracing agent.

## Documentation

See the main [WebPieces README](https://github.com/deanhiller/webpieces-ts#readme) for complete documentation and examples.

## License

Apache-2.0

Authentication and operation authorization are separate declarations. See [the migration guide](../../../docs/authorization-migration.md) for policies, canonical context, token-free MCP invocation, and validator release ordering.

## First-use controller implementations

Pass a `LazyController<Api>` as the second argument to the existing `router.addRoutes` call to
retain the API contract now and import its implementation on its first permitted invocation:

```typescript
const admin = new LazyController<AdminApi>(
    'AdminController',
    '**/AdminController.ts',
    10_000,
    async () => {
        const feature = await import('./admin/implementation');
        return new LazyImplementation(
            feature.AdminController,
            [new feature.AdminBindings(config)],
            [feature.AdminState],
            [SharedAccountStore],
        );
    },
);
router.addRoutes(AdminApi, admin);
```

Keep the descriptor's module lightweight: import contracts, prepared configuration and shared
identities there; import implementation classes and exclusive bindings INSIDE its loader. A static
implementation import, implementation barrel export or decorator `design:paramtypes` reference can
undo the boundary. A class passed directly to `addRoutes` retains eager registration.

Registration still expands API endpoints, validates their authentication and authorization, installs
normal filters, and publishes transport/tool metadata. The name and filter filepath are stable
metadata: the imported controller must retain that name, extend the API, implement every method,
and match explicit `@SourceFile` metadata. HTTP, in-process clients and local MCP dispatch reach the
same final handler. Denied calls do not import the implementation. A mixed API is one controller
feature: its first permitted method loads that controller, rather than independently loading each
method's JavaScript.

`LazyImplementation` declares four things: the concrete controller, binding modules, private concrete
singletons (excluding the controller, which is implicit), and explicitly shared application dependencies.
Private bindings live in an isolated container with autobinding disabled. Each shared dependency must
already be explicitly bound in the application; the bridge returns the application's instance and
preserves its scope instead of creating a second singleton. Bind shared services explicitly at startup
when no essential route would otherwise resolve them. Merely importing a class does not bind it.

An Inversify child with an autobinding parent is insufficient isolation: an `isBound` lookup can
create a binding in the parent. This implementation never uses such a child. Private `bind` calls
and private singleton declarations reject collisions with application bindings; a failed candidate
cannot partially rebind shared auth, logging or clients. RPC/task/external binding helpers inherit an
existing application edge binding (including test overrides) instead of replacing it. Declare shared
framework factories, such as `ClientHttpFactory`, when a private binding creates a client using them.

The descriptor has one initialization promise per router. Concurrent methods share it; successful
initialization reuses one controller; failure is retained until the router/process is rebuilt, with
no retry loop. One descriptor cannot register two different API contracts on the same router. The
same descriptor can be used by separate routers without sharing their controller or scoped state.
Import, binding and singleton construction run in a fresh detached `RequestContext`; each invocation
resumes in its own caller scope after initialization. Never capture a caller in the loader's closure.

The required positive timeout bounds asynchronous initialization waiting. A timeout retains failure
and prevents a late import/configuration from publishing a controller. JavaScript module evaluation
and synchronous constructors still run on the main thread: timers cannot preempt CPU work. Keep
loaders and binding modules declarative; they must not start request work, open background resources
or hide network warmups. This API adds no process signal/shutdown hooks. Host termination retains
existing behavior; pending imports are not a shutdown flush queue.

Existing transport cancellation and client deadlines remain transport-owned. The shared initialization
is not cancelled because one client stops waiting. Unary disconnects do not currently propagate a
cancellation signal into `MethodMeta`; this capability does not add one or promise that an already
accepted write is cancelled when its client disconnects. Initialization timeout is a separate limit.

Call `await router.validateLazyRoutesForBuild()` in a **separate build/integration process with fake
external providers** to import every registered optional implementation and validate its DI before
shipping. It invokes no API methods, refuses execution inside a request, and never bypasses subsequent
invocation auth. It warms that validation router, so never call it in the production entry point.
The production library excludes its `src/__tests__` tree, including the deferred-import fixtures.

Feature tests cover real imports, first/concurrent/later methods, distinct principals, shared state,
critical requests during a held import, retained import/binding/method failures, collision rejection,
late completion after timeout and explicit build validation. Separate loopback tests prove HTTP and
MCP discovery/auth/dispatch. No production speedup is claimed from these small fixtures: measure the
actual consuming image's startup, first optional request, later requests, essential requests during
initialization and memory separately. The selected Lang migration is
[ctoteachings/monorepo#3036](https://github.com/ctoteachings/monorepo/issues/3036).
