# PLAN — Explicit form-urlencoded endpoints via `@Endpoint(path, { formPost: true })`

## Context / problem

`WebpiecesMiddleware.executeImpl` (`packages/http/http-server/src/WebpiecesMiddleware.ts`)
**unconditionally `JSON.parse`s every POST/PUT/PATCH body**:

```ts
const bodyText = await this.readRequestBody(req);
requestDto = bodyText ? JSON.parse(bodyText) : {};   // JSON only, no content-type branch
```

That is correct for service-to-service calls (the webpieces client `JSON.stringify`s the body — symmetric). But an **external** caller that posts `application/x-www-form-urlencoded` breaks it: `JSON.parse('Body=hi&From=whatsapp%3A%2B1...')` throws `SyntaxError` → the wrapper returns **500**, before the controller runs.

Concrete driver: a Twilio inbound webhook. Its contract endpoint is declared today as
`@Endpoint(WHATSAPP_INBOUND_ENDPOINT)` with a flat `WhatsAppInboundRequest`, and the caller (Twilio,
fixed) always sends form-urlencoded. Under webpieces it 500s on every message. The previous
(express) stack worked only because it mounted BOTH `express.json()` and `express.urlencoded()` and
let the `Content-Type` header pick.

**Design decision (agreed):** do NOT sniff `Content-Type` and silently accept both — that hides an
unusual case. Instead make form-encoding **explicit and declared at the contract**, so it is obvious
and greppable, the default JSON path is unchanged, and a JSON endpoint keeps rejecting non-JSON.
The parser is chosen by the **annotation**, not the request header.

## Design

### 1. Extend `@Endpoint` — `@Endpoint(path, { formPost: true })`

`packages/core/core-util/src/http/decorators.ts` (the `Endpoint` function, ~line 140). Add an
optional 2nd arg. Keep the existing `ENDPOINTS` metadata (`Record<methodName, path>`) **unchanged**
for back-compat (every consumer — `getEndpoints`, `ApiRoutingFactory`, `ApiClientFactory` — iterates
it as `[methodName, path]`), and store options in a **parallel** metadata map so nothing else has to
change shape:

```ts
export interface EndpointOptions {
  /** Parse the request body as application/x-www-form-urlencoded (flat key→value) instead of JSON.
   *  For EXTERNAL webhooks (e.g. Twilio) that post form-encoded. The request DTO must be FLAT —
   *  urlencoded has no nesting (unlike JSON). Default false = JSON. */
  formPost?: boolean;
}

export const METADATA_KEYS = { /* ...existing... */ ENDPOINT_OPTIONS: 'webpieces:endpoint-options' };

export function Endpoint(path: string, options: EndpointOptions = {}): MethodDecorator {
  return (target, propertyKey) => {
    // ...existing ENDPOINTS write (path) stays exactly as-is...
    const opts = Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, metadataTarget) || {};
    opts[propertyKey] = options;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, opts, metadataTarget);
  };
}

/** Options for one endpoint method (empty object if none). */
export function getEndpointOptions(apiClass: Function, methodName: string): EndpointOptions {
  return (Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, apiClass) || {})[methodName] ?? {};
}
export function isFormPost(apiClass: Function, methodName: string): boolean {
  return getEndpointOptions(apiClass, methodName).formPost === true;
}
```

Export `EndpointOptions`, `getEndpointOptions`, `isFormPost` from `core-util`'s index.

### 2. Thread `formPost` onto the route metadata

`executeImpl` runs per-route and only holds `this.path` — it does NOT know the apiClass/methodName.
So the flag must ride the route's metadata. In `RouteMetadata`/`MethodMeta`
(`packages/http/http-routing/src/…`) add a `readonly formPost: boolean` field, and populate it where
routes are registered (`ApiRoutingFactory` / `RouteBuilder`, where `Object.entries(endpoints)`
already loops per method): `formPost: isFormPost(apiClass, methodName)`. Then the per-route
`WebpiecesMiddleware` is constructed with (or can look up) that route's meta.

### 3. Branch the body parse in `WebpiecesMiddleware.executeImpl`

`packages/http/http-server/src/WebpiecesMiddleware.ts` — replace the unconditional parse with a
decision driven by the route's `formPost` flag (NOT the Content-Type header):

```ts
import * as querystring from 'node:querystring';
// ...
if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
  const bodyText = await this.readRequestBody(req);
  if (this.routeMeta.formPost) {
    // Reuse the SAME engine express.urlencoded({ extended: false }) uses — Node's built-in
    // querystring (zero new dependency). This is exactly what the old express stack parsed
    // Twilio with. Flat Record<string, string | string[]>; lenient (never throws). For nested
    // bracket-notation you'd swap in `qs.parse` (the express extended:true engine) — not needed here.
    requestDto = querystring.parse(bodyText);
  } else {
    // JSON (default). A non-JSON body is a client error → 400, not a 500.
    try {
      requestDto = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new HttpBadRequestError('Request body is not valid JSON');
    }
  }
}
```

**Who parses:** webpieces itself, right here — NOT an express body-parser (there is none in the
chain; `readRequestBody` reads the raw stream and keeps the wrapper transport-neutral). We just feed
that raw string to the same parser express would have used. `querystring` (Node built-in) = the
`extended:false` engine; `qs` = the `extended:true` (nesting) engine, if ever needed.

Two behaviors this locks in, both matching the decision:
- **JSON endpoints reject non-JSON** — as wanted. (Also upgrades today's raw 500 to a clean 400.)
- **Content-Type is ignored for the decision.** The annotation is the single source of truth. (A
  future option: optionally 415 if the header contradicts the annotation — deliberately left out.)

### 4. Client side — FAIL FAST on `formPost` (not supported yet)

`ProxyClient` / `ApiClientFactory` `JSON.stringify` outbound bodies, and form endpoints exist only
for EXTERNAL inbound webhooks (Twilio is the caller — there is no webpieces client for them). So
rather than silently send a malformed JSON body, the client must **refuse a `formPost` endpoint with
a clear error**. Do it where the proxy method is built, per method, so an API with a MIX of normal +
formPost endpoints still gets a working client for its normal methods — only calling the formPost one
throws:

```ts
// where proxy[methodName] is created (ApiClientFactory.ts, and the HTTP ProxyClient in
// http-client-core), guard by isFormPost(apiClass, methodName):
if (isFormPost(apiClass, methodName)) {
  proxy[methodName] = async (): Promise<never> => {
    throw new Error(
      `${apiClass.name}.${methodName} is @Endpoint(..., { formPost: true }) — the webpieces ` +
      `client does not support calling form-encoded endpoints yet. formPost is for EXTERNAL ` +
      `inbound webhooks (e.g. Twilio) only. If this endpoint needs a service-to-service client, ` +
      `set formPost:false (or remove it) so it uses JSON.`,
    );
  };
  continue; // don't build the normal JSON-sending method for it
}
```

This keeps the server-side (the actual Twilio use case) fully working while making the unsupported
client path loud and self-explaining instead of a silent wrong-encoding bug. A real form-encoding
client is a later follow-up if a service-to-service form endpoint ever appears.

## Files to change (webpieces-ts40)
| File | Change |
|---|---|
| `packages/core/core-util/src/http/decorators.ts` | `Endpoint(path, options?)`; `ENDPOINT_OPTIONS` metadata; `EndpointOptions`/`getEndpointOptions`/`isFormPost` |
| `packages/core/core-util/src/index.ts` | export the new symbols |
| `packages/http/http-routing/src/…` (RouteMetadata/MethodMeta + ApiRoutingFactory/RouteBuilder) | carry + populate `formPost` on route meta |
| `packages/http/http-server/src/WebpiecesMiddleware.ts` | annotation-driven parse (urlencoded vs JSON); 400 on bad JSON |

## Tests
- A `@Endpoint('/hook', { formPost: true })` endpoint: a urlencoded POST (`a=1&b=two`) arrives as `{ a: '1', b: 'two' }`.
- A default `@Endpoint('/rpc')` endpoint: a urlencoded/garbage body → **400** (not 500); a JSON body works.
- `isFormPost`/`getEndpointOptions` metadata round-trip.
- Flat-only: document (and optionally assert in review) that a `formPost` DTO has no nested fields.

## Downstream (mealco monorepo) — after this ships in a published `@webpieces/*`
- `libraries/apis/whatsapp-api`: `@Endpoint(WHATSAPP_INBOUND_ENDPOINT, { formPost: true })`; keep `WhatsAppInboundRequest` flat.
- Re-enable Twilio-signature verification as a webpieces `Filter` on the inbound route (now that the body parses, a filter can run — it reads the flat params + URL to compute the HMAC).
- Un-park ai-chat's inbound webhook (currently documented-but-disabled in `WhatsAppRoutes.ts`).

## Note on versions
ts40 is the 0.4 line. The mealco monorepo currently consumes the **0.3.x** line, so ai-chat's inbound
endpoint stays parked until either this lands on 0.3.x too OR the monorepo migrates to 0.4. Implement
here per the decision; sequence the mealco unpark against whichever version actually publishes it.
