# PLAN — Pluggable error translations via `ClientRegistry.addErrorTranslation`

## Context / problem

webpieces has **symmetric** error handling across the wire:

- **Server (exception → JSON):** `WebpiecesMiddleware.handleError(res, error)`
  (`packages/http/http-server/src/WebpiecesMiddleware.ts`) turns an `HttpError` into a
  `ProtocolError` JSON body + `res.status(error.code)`.
- **Client (JSON → exception):** `ClientErrorTranslator.translateError(response, protocolError)`
  (`packages/http/http-client-core/src/ClientErrorTranslator.ts`, called from `ProxyClient.ts:202`)
  reconstructs the typed `HttpError` subclass from the status code.

Both are **hard-coded `switch`/`instanceof` ladders over the built-in `HttpError` set**. An
application-defined error has no seam:

- `translateError`'s `default` branch returns a **plain `new Error("could not translate
  statusCode=460")`** — an app's custom exception (e.g. Mealco's `HttpAiBadRequestError` at HTTP
  **460**) is lost on the client; `err instanceof HttpAiBadRequestError` can never be true after an
  RPC hop, so callers can't distinguish it.
- `handleError` sends `res.status(error.code)` generically, but can't serialize app-specific fields
  and gives the app no way to override how a status is written.

**Goal:** let an app register, once at startup (server **and** browser), an `ErrorTranslation` with
two directions (exception→JSON, JSON→exception). Registered translations are consulted **first**;
if none match, we **fall through to the generic webpieces translation**. This means an app can both
**add** new error types and **override** built-in ones. The concrete driver: the Mealco monorepo
needs to inject its custom `HttpAiBadRequestError` (460) so the RPC client reconstructs it.

## Design

### 1. New contract: `ErrorTranslation` (in `core-util`)

New file `packages/core/core-util/src/http/ErrorTranslation.ts` (browser-safe, zero node deps):

```ts
import { ProtocolError } from './errors';

/** The wire form an error translates to: the HTTP status + the ProtocolError body fields. */
export interface ErrorWireForm {
  statusCode: number;
  protocolError: ProtocolError;
}

/**
 * A bidirectional, app-supplied translation between one (or more) exception types and their wire
 * form. Registered on ClientRegistry at startup; consulted BEFORE the built-in webpieces mapping.
 * BOTH methods return `undefined` to mean "not mine — fall through to the next translation, then to
 * generic webpieces." This is what lets translations be additive AND override built-ins.
 */
export interface ErrorTranslation {
  /** exception → JSON. Return the wire form, or undefined if this translation doesn't handle `error`. */
  toWire(error: Error): ErrorWireForm | undefined;

  /** JSON → exception. Return the reconstructed typed error, or undefined to fall through. */
  fromWire(statusCode: number, protocolError: ProtocolError): Error | undefined;
}
```

Export both from `packages/core/core-util/src/index.ts` (next to the existing `ProtocolError` /
`ClientRegistry` exports at lines ~74–113).

### 2. Extend `ClientRegistry` (in `core-util`)

`packages/core/core-util/src/http/ClientRegistry.ts` — add an error-translation list alongside the
existing URL `mappings`/`deriver` (identical process-global, startup-populated, no-DI pattern):

```ts
private static readonly errorTranslations: ErrorTranslation[] = [];

/** Register an app error translation. Consulted before webpieces' built-in mapping, in
 *  registration order (first match wins), so later app types AND overrides of built-ins both work. */
static addErrorTranslation(translation: ErrorTranslation): void {
  ClientRegistry.errorTranslations.push(translation);
}

/** exception → wire, or undefined if no registered translation claims `error` (→ generic path). */
static tryTranslateToWire(error: Error): ErrorWireForm | undefined {
  for (const t of ClientRegistry.errorTranslations) {
    const wire = t.toWire(error);
    if (wire !== undefined) return wire;
  }
  return undefined;
}

/** wire → exception, or undefined if none claims (statusCode, protocolError) (→ generic path). */
static tryTranslateFromWire(statusCode: number, protocolError: ProtocolError): Error | undefined {
  for (const t of ClientRegistry.errorTranslations) {
    const err = t.fromWire(statusCode, protocolError);
    if (err !== undefined) return err;
  }
  return undefined;
}
```

Also clear the list in the existing `ClientRegistry.clear()` (test hygiene):
`ClientRegistry.errorTranslations.length = 0;`.

> **Naming note:** error translation is used by BOTH server and client, so it's a slight stretch to
> hang it off `ClientRegistry` (whose other members are client-URL resolution). Chosen per the
> request and because `ClientRegistry` is already the browser-safe, startup-populated core-util
> singleton both sides import. Alternative if preferred later: a sibling `ErrorTranslationRegistry`
> in the same folder with the same three methods — the wiring in §3/§4 is identical either way.

### 3. Wire the CLIENT side (JSON → exception) — fall through to generic

`packages/http/http-client-core/src/ClientErrorTranslator.ts`, top of `translateError(...)`, BEFORE
the `switch`:

```ts
const custom = ClientRegistry.tryTranslateFromWire(response.status, protocolError);
if (custom !== undefined) return custom;
// ...existing switch(statusCode) unchanged — the generic fallback...
```

Custom translations win; unknown-to-them status codes fall through to the built-in switch exactly as
today. (Also upgrade the `default` branch to a real `HttpError` while here — optional.)

### 4. Wire the SERVER side (exception → JSON) — fall through to generic

`packages/http/http-server/src/WebpiecesMiddleware.ts`, top of `handleError(res, error)`, BEFORE the
`if (error instanceof HttpError)` ladder:

```ts
if (error instanceof Error) {
  const wire = ClientRegistry.tryTranslateToWire(error);
  if (wire !== undefined) {
    if (res.headersSent) return;
    res.status(wire.statusCode)
       .setHeader('Content-Type', 'application/json')
       .send(JSON.stringify(wire.protocolError));
    return;
  }
}
// ...existing instanceof-HttpError ladder unchanged (generic fallback)...
```

Keeps full symmetry: `toWire` (server) and `fromWire` (client) are the two halves the app supplies
together.

### 5. Startup seams — where an app registers translations

`addErrorTranslation` is a plain global, callable from any startup path, mirroring how apps already
call `ClientRegistry.addMapping(...)` today:

- **Server** — two supported ways:
  1. **Bound outside** (simplest, matches `apps/app-example/*/src/server.ts:16,23` which already call
     `ClientRegistry.addMapping('server2', 8202)`): the app calls
     `ClientRegistry.addErrorTranslation(new MyTranslation())` right there at startup.
  2. **Bound inside company setup** (preferred for the express server): add an optional field to
     `CompanySetupOptions` (`apps/app-example/company-svc-core/src/CompanySetupOptions.ts`):
     ```ts
     public readonly errorTranslations: ErrorTranslation[] = [],
     ```
     and have `setupCompanyRuntime(...)` install them
     (`options.errorTranslations.forEach(t => ClientRegistry.addErrorTranslation(t))`) at the same
     point it installs the logger factory / registry config. This makes translations part of the
     express-server wiring "only when express is used," while still allowing the outside/inside
     binding the app prefers.
- **Browser (Angular)** — the SAME call on startup. `apps/app-example/angular-site/src/app/app.config.ts:65`
  already calls `ClientRegistry.addUrlMapping(...)`; the app adds
  `ClientRegistry.addErrorTranslation(new MyTranslation())` in the same block. Because the contract
  and `ClientRegistry` are browser-safe core-util, the identical translation object works in both
  environments — the client `fromWire` path is what the browser exercises.

### 6. Downstream consumer example (the Mealco 460 driver)

In the consuming monorepo (defines `HttpAiBadRequestError extends HttpError` at code 460):

```ts
class AiErrorTranslation implements ErrorTranslation {
  toWire(error: Error): ErrorWireForm | undefined {
    if (!(error instanceof HttpAiBadRequestError)) return undefined;
    const pe = new ProtocolError();
    pe.message = error.message;
    pe.name = error.name;      // 'AiBadRequest'
    pe.subType = error.subType;
    return { statusCode: 460, protocolError: pe };
  }
  fromWire(statusCode: number, pe: ProtocolError): Error | undefined {
    if (statusCode !== 460) return undefined;
    return new HttpAiBadRequestError(pe.message ?? 'AI bad request');
  }
}

// server startup AND angular startup:
ClientRegistry.addErrorTranslation(new AiErrorTranslation());
```

After this, an `HttpAiBadRequestError` thrown in a service survives the RPC hop and
`err instanceof HttpAiBadRequestError` is true on the client — the whole reason the monorepo needs it.

## Files to change

| File | Change |
|---|---|
| `packages/core/core-util/src/http/ErrorTranslation.ts` | **new** — `ErrorTranslation`, `ErrorWireForm` |
| `packages/core/core-util/src/http/ClientRegistry.ts` | add `errorTranslations` + `addErrorTranslation` / `tryTranslateToWire` / `tryTranslateFromWire`; clear in `clear()` |
| `packages/core/core-util/src/index.ts` | export the new types |
| `packages/http/http-client-core/src/ClientErrorTranslator.ts` | consult `tryTranslateFromWire` first, else existing switch |
| `packages/http/http-server/src/WebpiecesMiddleware.ts` | consult `tryTranslateToWire` first in `handleError`, else existing ladder |
| `apps/app-example/company-svc-core/src/CompanySetupOptions.ts` | optional `errorTranslations` field + install in `setupCompanyRuntime` |

## Tests

- `packages/core/core-util/src/http/__tests__/ClientRegistry.spec.ts` — register/lookup/first-match-wins/`clear()` for translations.
- New `ErrorTranslation` round-trip spec: a custom translation → `toWire` → `fromWire` reproduces the typed error; unregistered status falls through to generic; a registered override of a built-in status (e.g. 400) wins over the built-in.
- Symmetry guard: server `handleError` + client `translateError` agree for a custom translation (mirror the existing "must match ClientErrorTranslator" invariant).

## Notes / decisions

- **Fall-through, not replace:** built-in `switch`/`instanceof` ladders stay as the default; the
  registry is only consulted first. Zero behavior change for apps that register nothing.
- **`undefined` = "not mine":** both directions use `undefined` to fall through — the single rule
  that makes translations composable and override-capable.
- **Browser parity:** contract + registry live in `core-util` (already browser-safe), so one
  translation object serves node server and Angular client.
