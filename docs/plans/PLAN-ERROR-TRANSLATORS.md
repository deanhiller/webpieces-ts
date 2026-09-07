# PLAN — ONE symmetric `setErrorTranslators` owning the WHOLE response

Supersedes `PLAN-ERROR-TRANSLATION-REGISTRY.md` (deleted). That plan shipped
`ClientRegistry.addErrorTranslation` / `ErrorTranslation` / `ErrorWireForm`, and this one **deletes
all three** rather than deprecating them — see `.claude/rules/no-backwards-compat.md`: the compile
error is the migration. Tracked by issue #862.

## Context / problem

An app's error contract broke on a malformed request body, and the diagnosis found two separate
defects sitting on top of each other.

**1. The wire form could not express a response.** `ErrorWireForm` was `(statusCode, protocolError)`.
An app therefore could not put its own trace id, `Retry-After`, `WWW-Authenticate` or a cookie on an
error response, and could not choose the reason phrase beside its own status code.

**2. The translator ran with an EMPTY request scope.** `ExpressWrapper.executeImpl` ran in this
order:

```
1. readRequestBody -> JSON.parse         <- THROWS HttpBadRequestError
2. toWebpiecesRequest
3. headers.fillFromRequest(httpRequest)  <- publishes RequestContext.getRequest()
4. filter chain
```

A real app's `toWire` asks "is this MY surface?" before claiming an error, and the only place the
surface lives is `RequestContext.getRequest()` — published at step 3, *after* the step-1 throw. So on
a malformed body the translator answered "not mine", and webpieces' generic envelope went out in
place of the app's published contract. `handleError` DOES run inside `RequestContext.run(...)`, so the
scope existed and was merely unpopulated. **The translator was never too late. The context it needed
was.**

## Design

### 1. `HttpResponseDto` — the whole response, as pure data

`packages/core/core-util/src/http/HttpResponseDto.ts`, beside `errors.ts`. Modelled on java
webpieces' `http/http1_1-parser/.../api/dto/`, flattened to the KISS subset:

```ts
class HttpHeader         { name: string; value: string }
class HttpResponseStatus { code: number; reason: string }
class HttpResponseDto    { status: HttpResponseStatus; headers: readonly HttpHeader[]; body: unknown }
```

Two properties copied from java deliberately:

- **Headers are a LIST, not a Map** — HTTP permits repeats (`Set-Cookie`) and a Map drops them. The
  request side already respects this (`readExpressHeaders` returns `Map<string, string[]>`).
- **Status is `{code, reason}`, not a bare number** — the reason phrase is part of the response.

`HttpVersion` is omitted: express and fetch each own it and no app decision depends on it.

This DTO is also **the answer to "express vs fetch"**: the two model a response completely
differently, so neither is handed to the app. webpieces normalises both into this at its own
boundary — `ExpressWrapper.send` writes one out, `HttpResponseDtoFactory.fromFetch` reads one in.

### 2. `ErrorTranslators` replaces `ErrorTranslation`

```ts
interface ErrorTranslators {
    toWire(error: Error): HttpResponseDto | undefined;        // SERVER
    fromWire(response: HttpResponseDto): Error | undefined;   // CLIENT
}

ClientRegistry.setErrorTranslators(translators: ErrorTranslators): void;
```

`set`, not `add`: **one** per process. An app with several layers of error policy composes them
inside its own `toWire`, where the precedence is written down, instead of leaving it implicit in the
order two unrelated startup paths happened to register.

`toWire` produces exactly what `fromWire` consumes, and both live in one object so they can be read
against each other. `undefined` means "not mine" in both directions.

### 3. The ordering fix, and the limitation that was accepted with it

`executeImpl` now publishes the transport-neutral request at **step 0**, before anything that can
throw, and republishes it at step 3 with the raw bytes when the route asked for them (so
`@AuthWebhook` signature verification is unchanged).

**ACCEPTED KNOWN ISSUE, documented not fixed:** `fillFromRequest` — which mints a transaction id when
the caller sent none — stays below the body read. A malformed or oversize body therefore produces an
error response with NO transaction id for the caller to quote at support. Minting it early would drag
the raw-body republish into every route; that complexity was declined. Pinned by a test in
`ErrorTranslationSymmetry.spec.ts` so a future change to it is a decision, not an accident.

**Out of scope:** 404 / unknown route. No route means no context and no app translator.

### 4. The webpieces default, when no translators are installed

- The **txId response header goes on EVERY response**, success and error, default and app-translated
  alike. It is infrastructure, not app policy, so an app that overrides the error BODY must not have
  to remember to re-emit the trace header. Same for `Content-Type: application/json`, which an app can
  still override by naming it in its own header list.
- Otherwise today's behaviour: `HttpErrorWireMapper` on the server, `ClientErrorTranslator.builtInError`
  on the client.
- Both defaults are **DELEGABLE and exported**: `HttpErrorWireMapper.toResponse(error)` returns the
  same `HttpResponseDto` an app's `toWire` returns, and `ClientErrorTranslator.builtInError(response)`
  is public. A consumer had copied `HttpErrorWireMapper`'s status-to-message table verbatim into its
  own envelope class — copying framework internals is the symptom of a missing export.

## Files changed

| File | Change |
|---|---|
| `core-util/src/http/HttpResponseDto.ts` | **new** — `HttpHeader`, `HttpResponseStatus`, `HttpResponseDto` |
| `core-util/src/http/ErrorTranslators.ts` | **new** — replaces the deleted `ErrorTranslation.ts` |
| `core-util/src/http/ClientRegistry.ts` | one slot + `setErrorTranslators`; both `tryTranslate*` now speak the DTO |
| `http-server/src/HttpErrorWireMapper.ts` | `toResponse()` (the delegable default) + public `genericMessage()` |
| `http-server/src/ExpressWrapper.ts` | step-0 publish, one `send(HttpResponseDto)`, txId on every response |
| `http-client-core/src/HttpResponseDtoFactory.ts` | **new** — fetch `Response` -> the DTO |
| `http-client-core/src/ClientErrorTranslator.ts` | `translateError(HttpResponseDto)`; `builtInError` public |
| `apps/app-example/client-server-api/src/OrderErrors.ts` | **new** — the ONE-class-BOTH-directions example |

## Tests

- A translator setting a custom header, status code AND reason phrase gets all three on the wire, and
  two `Set-Cookie`s survive — proving the list-not-map choice (`HttpErrorWireMapper.spec.ts`,
  `HttpResponseDtoFactory.spec.ts`).
- `fromWire` receives the identical shape from a node and a browser client: both share `ProxyClient`,
  whose only DTO source is `HttpResponseDtoFactory`.
- **Server throws `X` -> client catches `X`** over real HTTP (`e2e/ErrorTranslationSymmetry.spec.ts`).
- No translators installed -> the default still emits the txId header on a 200 and on an error.
- The accepted limitation: malformed body yields NO txId.
