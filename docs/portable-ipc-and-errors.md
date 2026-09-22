# Portable API errors and IPC

Use the same semantic exception constructors in browser, Node and React Native code:

```typescript
import { ApiEndUserError, ApiNotFoundError } from '@webpieces/core-util/errors';
throw new ApiEndUserError('Passwords do not match', 'password-mismatch');
```

An error is a business/API outcome; a transport adapter decides how to represent it. HTTP keeps status **266** for `ApiEndUserError`: the HTTP request and health monitoring succeed, but the generated client decodes and throws `ApiEndUserError` so a GUI can catch it and show its safe message. The shared browser/Node response path now explicitly translates 266 before ordinary Fetch `ok` handling. Generated-client regression tests cover that path and custom translator precedence. IPC carries the semantic kind in a JSON reply and throws the same canonical constructor on the client. Neither transport returns an error payload as successful API data.

## Taxonomy and HTTP adapter defaults

`ApiError` is an abstract category and has no status mapping. An API boundary normalizes every
unclassified throw to the concrete `ApiImplementationError`; that type maps to 500. The remaining
defaults are `ApiEndUserError` 266, `ApiBadRequestError` 400, `ApiUnauthorizedError` 401,
`ApiForbiddenError` 403, `ApiNotFoundError`/`ApiEndpointNotFoundError` 404,
`ApiRequestTimeoutError` 408, `ApiConflictError` 409, `ApiPreconditionFailedError` 412,
`ApiUnsupportedMediaTypeError` 415, `ApiUnprocessableError` 422, `ApiRateLimitedError` 429,
`ApiNotImplementedError` 501, `ApiDependencyError`/`ApiBadGatewayError` 502,
`ApiUnavailableError`/`ApiDependencyBackoffError` 503, and `ApiDependencyTimeoutError` 504.
The backoff form also emits `Retry-After`.

`ApiEndUserError(message, errorCode?, edgeHttpStatus?, cause?)` also carries an optional
`edgeHttpStatus` (`EdgeHttpStatus`: 400, 404, 409 or 422). `ApiErrorCodec` keeps it across every
remote hop like `errorCode`; a peer that does not send it decodes as `undefined`. Whether it is USED is a
property of the CALLER, not of the router: `AuthFilter` stamps `WebpiecesCoreHeaders.SURFACE` from
the auth mode that matched, and a `public-api` caller (`@WpAuthApiKey`) is answered
`edgeHttpStatus`, or 400 when it is absent. `gui`, `llm` and a caller whose auth established no
surface are all answered 266, because each is a webpieces client that decodes the body itself. `edgeHttpStatus` was inserted before `cause` (issue #948), so a call that passed `cause`
third must now pass it fourth.

Any other status uses the catch-all `ApiCodedError(message, statusCode, errorCode?, cause?)`. Its
`statusCode` is typed `ApiStatusCode` (every integer 100-599), so an out-of-range or fractional code
does not compile; narrow a dynamic number with `ApiCodedError.isStatusCode`. A code a named class
already owns is accepted. `ApiErrorCodec` carries `statusCode` and `errorCode` across every remote
hop (the message stays generic), and the HTTP client rebuilds an `ApiCodedError` for any 100-599
status it has no named class for. Below 500 it is classified as a caller error (except 408 and 429,
which mirror `ApiRequestTimeoutError` and `ApiRateLimitedError`); 500 and above is a server fault.

There are no HTTP-prefixed aliases. Applications that need a custom exception TYPE for a status
register an `ErrorTranslator` on `ClientRegistry` and THROW it from `fromWire`.

The webpieces default preserves retry-relevant dependency semantics: received 408/504 becomes
`ApiDependencyTimeoutError`, 429 becomes `ApiDependencyBackoffError`, 502 becomes
`ApiBadGatewayError`, and 503 becomes `ApiUnavailableError` (or backoff when `Retry-After` is
present). Typed Webpieces dependency errors pass through unchanged. Other received 4xx is
`ApiImplementationError` (my bug), other 5xx is generic `ApiDependencyError` (their bug), and 266
keeps its `ApiEndUserError` verbatim. The rule is shared by node, browser, and IPC.

`ApiEndpointNotFoundError` remains distinct from domain `ApiNotFoundError`.
`ApiCallTimeoutError(timeoutMs, CallContext)` is a subtype of `ApiDependencyTimeoutError` while
retaining its local deadline and call context. `ApiConnectionError` remains available for actual
offline classification; IPC disconnection uses the local `IpcTransportError`.

`ApiErrorCodec` uses a fixed allowlist of semantic kinds, not a remote JavaScript class name. End-user messages and explicitly safe `callerMessage` validation text are bounded; implementation messages become generic. Semantic causes cross the boundary up to three levels deep using the same safe field policy; cycles are bounded. Stack traces and arbitrary error object properties never cross the boundary. A locally constructed `ApiImplementationError` has `serverError === false`; a remote decoder sets it to `true`. Browser and native global reporters can therefore distinguish server failures from local website/mobile code failures without trusting a wire flag.

```typescript
if (error instanceof ApiImplementationError) {
    const category = error.serverError
        ? 'Server Error'
        : runtime === 'native' ? 'Mobile App Code Error' : 'Website Code Error';
    report(category, error);
}
```

## Factories and connection ownership

See the package READMEs for typed contract, client, receiver, logging and lifecycle examples:

- `packages/core/ipc-bridge/README.md`

One `@webpieces/ipc-bridge` package exports both `IpcClientFactory` and `IpcServerFactory`, using one shared JSON connection. Install it on both sides; each side can call and receive APIs. The application supplies its WebView/bus adapter, scheduler, unique ID generator, and reporting owner. There is one incoming dispatcher per connection, hosting multiple registered APIs. No vendor Node types, DI framework or platform runtime is part of the public factories. The shared API class declares its stable wire identity with class-level `@WpInternal('api-id')`, and every method declares its stable wire identity with `@WpIpcEndpoint('method-id')`. Pass that annotated API class directly to `createClient(Api)` and `create(Api, Controller)`; consumers do not construct a separate contract or request/response schemas.

Every call is acknowledged, including void and notification methods. Client logging surrounds reply decoding; server logging surrounds dispatch and invocation before failure encoding. IPC payloads remain parsed JSON with compile-time DTO typing rather than runtime schema validation or DTO reconstruction. `ApiEndUserError` is rethrown while retaining success/OTHER monitoring semantics. Nested calls use explicit scoped context; concurrent calls do not share mutable async state. The application must observe OS-callback promises and handle failures at its chosen reporting boundary. No timeout triggers automatic retries or proves that the remote side effect did not happen.

## React Native support and verification

The supported core entrypoints are **`@webpieces/core-util/errors` and `@webpieces/core-util/ipc`**. The broad legacy root barrel is not certified as an RN entrypoint. The `@webpieces/ipc-bridge` root entrypoint supports both factories. Their project tags are backed by mandatory `react-native-compat` targets, with transitive inputs, required builds, public declaration checks without Node/DOM ambient types, runtime dependency scanning, Metro Android/iOS bundles, and Hermes bytecode compilation. Compiler-only Hermes tooling cannot execute the bundle; compilation is not a Hermes runtime or physical-device test.

The authoritative PR build checks every RN-tagged project's required target before affected CI, so adding the tag without a target fails. Consumer declaration fixtures also reject incomplete API metadata. Negative scanner fixtures cover Node built-ins, DOM globals, dynamic loading and a transitive package whose harmless declarations hide Node runtime code.

Release is the framework's existing main-branch npm pipeline. New package names require their first authenticated publication and trusted-publisher setup; subsequent releases use the existing GitHub Actions OIDC workflow. Consume matching versions of the core-util and ipc-bridge packages to preserve constructor identity. Framework publication does not update installed native shells. Dean performs downstream Android/iOS installation, locked-screen/resume, durable listening and lifecycle verification in the application; this change does not deploy the website or increment its shell protocol.
