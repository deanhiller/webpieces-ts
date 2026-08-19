# FEATURE: `@AuthApiKey(name)` — a lookup hook that authenticates a CUSTOMER api key and seeds RequestContext

**Packages:** `@webpieces/core-util` (decorators, `AuthMode`), `@webpieces/http-routing`
(`AuthHooks`, `AuthConfig`, `AuthFilter`)
**Version seen:** `0.4.616`
**Severity:** High — a partner-facing HTTP API authenticated by a customer-held API key is
**unexpressible today**. The only reachable posture is `@Public`, and the one existing mode that
*looks* close (`@AuthSharedSecret`) is wrong in a way that is worse than `@Public`: it flips the
inbound trust boundary toward the customer.

## Symptom

`mealco-internal/monorepo-nx` is standing up the OneTablet **Management API** — a partner contract
consumed by other companies' codebases (POS vendors, back-office platforms, ETL pipelines) —
as a webpieces contract mounted side-by-side with a legacy NestJS app (ONE-2615).

Its authentication model is: **a customer-held API key, plus an organization id, checked
together.** The key names a customer; the org id names which of that customer's organizations
this request is for; the pair must be validated against a datastore, and the resolved
organization must land in `RequestContext` so every downstream repository call is org-scoped.

The contract cannot say that. It currently reads:

```ts
@Public()                       // <- not the intent; the only thing that compiles
@ApiPath('/management/v1')
export abstract class ManagementApi { ... }
```

## Why each existing `AuthMode` fails

`AuthMode` is a closed union (`core-util/src/http/decorators.d.ts`):

```ts
public | jwt | oidc | shared-secret | local-only
```

**`shared-secret` — has the right SHAPE, the wrong SEMANTICS.** `@AuthSharedSecret(name)` already
carries the "named lookup" ergonomics this feature wants. But it is a constant-time compare
against a static value (`AuthFilter.js:236-245`), so it cannot do a datastore lookup, cannot see a
second header, and — critically — populates **no context at all**. There is no seam by which the
authenticated identity reaches `RequestContext`.

And it is on the **wrong side of the trust boundary** (`AuthFilter.js:118-127`):

```js
static verifiesCaller(mode) {
    switch (mode.kind) {
        case 'oidc':
        case 'shared-secret':   return true;   // "An internal service is on the other end and the
                                               //  trusted context it forwarded may be believed."
        case 'jwt':
        case 'public':
        case 'local-only':      return false;
    }
}
```

A customer API key is emphatically **not** "an internal service on the other end." Declaring a
partner endpoint `@AuthSharedSecret` would tell the framework to **believe trusted context keys
forwarded by a customer** — i.e. a partner could assert someone else's org id on the wire and have
it admitted. That is a privilege-escalation path, and it is why "just use shared-secret" must not
be the answer. Any new mode here has to sit with `jwt` in the `false` branch.

**`jwt` — populates context, but structurally cannot see the second header.** `JwtHook` is the one
existing mode that seeds `RequestContext`, and its `AuthValues.entries: ContextTuple[]` is exactly
the mechanism wanted. But (`AuthHooks.d.ts`):

```ts
abstract parseJwt(token: string): AuthValues;
```

The hook receives **the token string and nothing else**. Every mode extracts a single credential
from a single header — `AUTHORIZATION_HEADER = 'authorization'` (`AuthFilter.js:22`, read once at
`:72`) — so a hook physically cannot reach a second header to cross-check the org id against the
key. It is also synchronous, and a datastore lookup is not. And `JwtRequirement`'s roles any-of is
not the authorization question being asked.

**`oidc`** is Google service-to-service. **`local-only`** is a deployment gate. **`public`** is the
status quo being escaped.

## The gap, stated once

There is no auth mode that is (a) **asynchronous**, (b) handed **the request's headers** rather
than one pre-extracted token, (c) able to return **`ContextTuple` entries** the framework puts into
`RequestContext`, and (d) classified as **caller-NOT-verified** so inbound trusted keys stay
rejected.

`jwt` has (c) and (d). `shared-secret` has the decorator shape. Nothing has (a) or (b), and no
combination of the existing five gets all four.

## Proposed shape

Parallel to `JwtHook` in every respect — an optional hook, a Symbol DI token, unbound means the
endpoint fails fast with 401 — because the app owns the strategy (which headers, which datastore,
which cross-check) and the framework cannot guess it.

```ts
// core-util: sixth AuthMode kind. `name` is the app's lookup key, exactly like
// @AuthSharedSecret(name) — one server can serve several key regimes.
| { kind: 'apikey'; name: string }

export function AuthApiKey(name: string): ClassDecorator & MethodDecorator;
```

```ts
// http-routing: the hook. ASYNC, and handed a reader rather than one token.
export abstract class ApiKeyHook {
  /**
   * AUTHENTICATION. `name` is the @AuthApiKey argument, so one hook can serve several regimes.
   * Return who the caller is + the context to seed, or throw HttpUnauthorizedError.
   */
  abstract verifyApiKey(name: string, headers: HeaderReader): Promise<AuthValues>;
}
export const API_KEY_HOOK: unique symbol;
```

`HeaderReader` need be no more than `{ getHeader(name: string): string | undefined }` — the
`RequestContext.getRequest()` surface `AuthFilter` already uses at `:72`. Passing that rather than
a pre-extracted token is the whole point: it is what lets one hook read **both** the key header and
the org header and validate them **as a pair**.

Reusing `AuthValues` means the context-seeding path is the one that already exists — the framework
puts `entries` into `RequestContext` via `putTrusted`, which is precisely the behaviour wanted
(`AuthConfig.d.ts`, `AuthValues`).

`AuthFilter.verifiesCaller` gains `case 'apikey': return false;` — same branch as `jwt`. The
switch is exhaustive with no `default`, so adding the union member forces this decision at compile
time rather than defaulting silently, which is exactly the property that comment was written for.

Consumer side, for concreteness:

```ts
@AuthApiKey('onetablet-partner')
@ApiPath('/management/v1')
export abstract class ManagementApi { ... }
```

```ts
export class OneTabletApiKeyHook extends ApiKeyHook {
  async verifyApiKey(name: string, headers: HeaderReader): Promise<AuthValues> {
    const key = headers.getHeader('x-api-key');
    const orgId = headers.getHeader(OneTabletKey.ORG_ID.getHeaderName());
    const record = await this.keys.findByHash(sha256(key));            // datastore lookup
    if (!record || record.organizationId !== orgId) {                  // the PAIR check
      throw new HttpUnauthorizedError('api key / organization mismatch');
    }
    return new AuthValues(record.apiKeyId, [], [
      OneTabletKey.ORG_ID.tuple(record.organizationId),                // seeds RequestContext
    ]);
  }
}
```

## Notes / open questions for the framework side

1. **Async in the auth path.** `parseJwt` is sync; this hook cannot be. Whether `AuthFilter`
   already awaits per-mode enforcement, or needs an async seam added, is a framework-side call.
2. **Where the credential header name is decided.** Above it is the app's business
   (`x-api-key` is read inside the hook). The alternative — the framework extracting a configured
   header and passing the value — is simpler but loses the multi-header cross-check that is the
   entire reason for this request. Recommend the app owns it.
3. **Whether a webhook/callback mode is the same feature.** This is adjacent to
   [`feature-a-verification-hook-so-an-external-endpoint-can-prove-its-calledby.md`] in this
   backlog: both want "verify this inbound request with my code." They may be one hook with two
   entry points, or two modes. Worth deciding together rather than shipping two near-duplicates.
4. **Rotation.** `SharedSecrets` gets zero-downtime rotation by accepting two values. An API key
   regime gets it from the datastore instead (N live keys per customer), so nothing framework-side
   is needed — noting it so the shared-secret shape is not copied wholesale.

## Why the consumer cannot fix this from its side

The `AuthMode` union is closed and `AuthFilter` switches on it exhaustively. There is no extension
point: an app can bind a `JwtHook`, but that hook is handed one token from one header and returns
synchronously. Nothing an app can write changes which headers reach it, and nothing an app can
write moves an endpoint out of the `verifiesCaller === true` branch. Until the framework has a
sixth mode, the honest declaration for a customer-API-key endpoint is `@Public` plus an
app-implemented check inside every controller method — unauthenticated as far as the framework,
the runtime graph, and every reviewer reading the contract are concerned.
