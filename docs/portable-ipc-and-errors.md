# Portable API errors and IPC

Use the same semantic exception constructors in browser, Node and React Native code:

```typescript
import { UserError, NotFoundError } from '@webpieces/core-util/errors';
throw new UserError('Passwords do not match', 'password-mismatch');
```

An error is a business/API outcome; a transport adapter decides how to represent it. HTTP keeps status **266** for `UserError`: the HTTP request and health monitoring succeed, but the generated client decodes and throws `UserError` so a GUI can catch it and show its safe message. The shared browser/Node response path now explicitly translates 266 before ordinary Fetch `ok` handling. Generated-client regression tests cover that path and custom translator precedence. IPC carries the semantic kind in a JSON reply and throws the same canonical constructor on the client. Neither transport returns an error payload as successful API data.

## Migration

The old HTTP leaf names are explicitly deprecated aliases of these constructors, preserving `instanceof` identity while consumers migrate imports. Canonical errors have a semantic `kind` and standard `cause`, with **no HTTP status field**. Code that reads an old leaf's `.code` must move status decisions into its HTTP adapter. The custom legacy `HttpError(message, code, subtype, cause)` remains an HTTP adapter with deprecation guidance; its `httpCause` accessor points to standard `cause`.

| Deprecated name | Canonical name |
|---|---|
| HttpUserError | UserError |
| HttpNotFoundError | NotFoundError |
| HttpBadRequestError | BadRequestError |
| HttpUnauthorizedError | UnauthorizedError |
| HttpForbiddenError | ForbiddenError |
| HttpInternalServerError | InternalError |
| HttpTimeoutError | RequestTimeoutError |
| HttpTooManyRequestsError | TooManyRequestsError |
| HttpBadGatewayError | BadGatewayError |
| HttpServiceUnavailableError | ServiceUnavailableError |
| HttpGatewayTimeoutError | GatewayTimeoutError |
| HttpVendorError | VendorError |

`EndpointNotFoundError` remains distinct from domain `NotFoundError`. Existing local `TimeoutError(timeoutMs, CallContext)` remains distinct from a remote request timeout. `OfflineError` remains available for actual offline classification; IPC disconnection uses `ServiceUnavailableError` instead.

`ApiErrorCodec` uses a fixed allowlist of semantic kinds, not a remote JavaScript class name. User messages and explicitly safe validation fields are bounded; internal messages become generic. Semantic causes cross the boundary up to three levels deep using the same safe field policy; cycles are bounded. Stack traces and arbitrary error object properties never cross the boundary. Logging is separate from Sentry: the application supplies the transport error owner and owns reporting policy.

## Factories and connection ownership

See the package READMEs for typed contract, client, receiver, logging and lifecycle examples:

- `packages/core/ipc-client/README.md`
- `packages/core/ipc-server/README.md`

The two portable packages use one shared JSON connection. The application supplies its WebView/bus adapter, scheduler, unique ID generator, and reporting owner. There is one incoming dispatcher per connection, hosting multiple registered APIs. No vendor Node types, DI framework or platform runtime is part of the public factories. Shared `IpcContract<Api>` metadata requires one schema/method entry per API member and explicit stable IDs. A contract is passed to `createClient`/`create`; abstract TypeScript method declarations alone cannot provide runtime schemas.

Every call is acknowledged, including void and notification methods. Client logging surrounds reply decoding; server logging surrounds schema validation and invocation before failure encoding. `UserError` is rethrown while retaining success/OTHER monitoring semantics. Nested calls use explicit scoped context; concurrent calls do not share mutable async state. The application must observe OS-callback promises and handle failures at its chosen reporting boundary. No timeout triggers automatic retries or proves that the remote side effect did not happen.

## React Native support and verification

The supported core entrypoints are **`@webpieces/core-util/errors` and `@webpieces/core-util/ipc`**. The broad legacy root barrel is not certified as an RN entrypoint. Both IPC package root entrypoints are supported. Their project tags are backed by mandatory `react-native-compat` targets, with transitive inputs, required builds, public declaration checks without Node/DOM ambient types, runtime dependency scanning, Metro Android/iOS bundles, and Hermes bytecode compilation. Compiler-only Hermes tooling cannot execute the bundle; compilation is not a Hermes runtime or physical-device test.

The authoritative PR build checks every RN-tagged project's required target before affected CI, so adding the tag without a target fails. Consumer declaration fixtures also reject incomplete API metadata. Negative scanner fixtures cover Node built-ins, DOM globals, dynamic loading and a transitive package whose harmless declarations hide Node runtime code.

Release is the framework's existing main-branch npm pipeline. New package names require their first authenticated publication and trusted-publisher setup; subsequent releases use the existing GitHub Actions OIDC workflow. Consume matching versions of the core and both IPC packages to preserve constructor identity. Framework publication does not update installed native shells. Dean performs downstream Android/iOS installation, locked-screen/resume, durable listening and lifecycle verification in the application; this change does not deploy the website or increment its shell protocol.
