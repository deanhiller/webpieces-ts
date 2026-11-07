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
