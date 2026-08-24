# BUG: ExpressWrapper puts EVERY HttpError's message on the wire, leaking internal detail

## Symptom

`ExpressWrapper.handleError()` (`packages/http/http-server/src/ExpressWrapper.ts`) copied the thrown
error's `message` onto the response body for **every** `HttpError` subclass, unconditionally:

```ts
protocolError.message = error.message;
protocolError.subType = error.subType;
protocolError.name = error.name;
```

…and then serialized `protocolError` as the JSON body. Whatever an operator wrote for the logs went
straight to the caller — including an external, partner-facing one.

## Why it is wrong

`Error.message` is an **operator-facing** field everywhere else in this framework. It is written for
whoever reads the logs, and it routinely quotes internal detail: a downstream service url, an HTTP
method and content-type, a body snippet, a table name, an internal id.

The behaviour was **exactly backwards**. The non-`HttpError` branch at the bottom of the same method
already did the right thing —

```ts
protocolError.message = 'Internal Server Error';
log.error('Unexpected error:', err);
```

— so an *unexpected crash* was safely generic while a *deliberate* `HttpInternalServerError` shipped
its full message outward. The more the framework knew about a failure, the more it leaked.

`name` was leaked the same way. For a built-in it is a constant 1:1 with the status code
(`'BadRequest'`, `'InternalServerError'`) — telling the caller nothing the status line had not
already told it — and for any subclass it is literally an internal class name
(`'EndpointNotFoundError'`, or whatever an app named its type). Nothing on the client ever read it.

## What made it urgent — commit `e4a6fdd` (PR #709)

`NodeProxyClient` now wraps a downstream 4xx into an `HttpInternalServerError` whose message quotes
the downstream url, the HTTP method, the content-type and a body snippet — built by
`ResponseBodyReader.describeForeignBody`. That diagnostic is *excellent* and is the whole reason the
mealco prod incident was findable in one read. It is also precisely the operator detail that must
never reach a partner API consumer:

```
Cannot POST /db-stores/fetch-stores   ← the downstream's own 404 html, quoted into our 500 body
```

The required `error-output-reviewer` flagged this yellow on PR #709 and it was deliberately deferred
to this task.

## The fix

**Only `HttpUserError`'s `message` goes on the wire.** It is the one type that MEANS "this text was
written for a human to read": deliberately a 266 (a 2xx code, so it is not lumped in with failures),
it carries an `errorCode`, and an app throws it on purpose ("Email already exists").

Every other `HttpError` sends a **generic, status-appropriate** message — the standard HTTP reason
phrase for its code — and the real message goes to the **log** only.

Kept on the wire, deliberately:

- `errorCode` (`HttpUserError`) and `waitSeconds` (`HttpVendorError`) — structured contract data the
  client branches on, not prose.
- `field` and `guiAlertMessage` (`HttpBadRequestError`). `guiMessage` exists precisely to be the
  human-safe half of a bad request; its existence is the admission that `message` is the
  operator-facing half. A form field name is not internal detail. `HttpBadRequestError.message`
  itself becomes generic like all the rest.
- `subType`. It is not derived from a class name — it is an explicit constructor argument an app
  passes on purpose (`WRONG_LOGIN`, `NOT_APPROVED`, `EMAIL_NOT_CONFIRMED`, …), so it is contract data
  of the same kind as `errorCode`, and `ClientErrorTranslator` reads it back when reconstructing
  `HttpUnauthorizedError` and the generic `HttpError`.

Dropped from the wire:

- `name`, for the reason above. It is logged instead, so nothing that was previously visible only on
  the wire is lost.

Left alone: `ClientRegistry.tryTranslateToWire()` still runs **first** and its `ProtocolError` is sent
verbatim. That is the app's own deliberate choice about what it publishes — the explicit opt-out, and
the mirror of `tryTranslateFromWire` on the client side.

The per-type decision moved out of the already-long `handleError` into its own class,
`packages/http/http-server/src/HttpErrorWireMapper.ts`, where the rule and its justifications are
stated once.

## How to verify

1. Throw each non-user `HttpError` subclass from a controller → the response body carries the generic
   reason phrase, never `error.message`.
2. Throw an `HttpInternalServerError` whose message contains a downstream url and
   `<pre>Cannot POST /db-stores/fetch-stores</pre>` (the PR #709 shape) → none of that text appears
   anywhere in the response body, and all of it appears in the log.
3. Throw an `HttpUserError` → its message DOES reach the wire, with `errorCode`.
4. Throw an `HttpBadRequestError` → `guiAlertMessage` and `field` reach the wire; its `message` does
   not.
5. Register an app `ErrorTranslation` → its `toWire()` output is passed through untouched.
6. Throw a plain `Error` → still `'Internal Server Error'`.
7. Round-trip server → wire → `ClientErrorTranslator` → the caller still gets the right typed error
   class, and a 401's `subType` still survives.

Covered by `packages/http/http-server/src/__tests__/HttpErrorWireMapper.spec.ts`.

## Reported by

Dean, from the yellow `error-output-reviewer` verdict on PR #709.
