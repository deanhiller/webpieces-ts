# FEATURE: `@AuthApiKey` must carry credential LOCATION — and a multi-header PAIR — so a spec generator can emit `securitySchemes`

**Packages:** `@webpieces/core-util` (`AuthApiKey`, `AuthMode`), and anything reading route auth
metadata (spec generators, docs generators)
**Version seen:** `0.4.672`
**Severity:** Medium-High — not a runtime defect. It is a **correctness-of-published-contract**
defect: the generated OpenAPI document's security block cannot be derived, so it is hand-written,
so it drifts from what the server actually enforces, silently, with no build signal. For a
**partner** contract that drift surfaces as a vendor integration failure.

## Context

`mealco-internal/monorepo-nx` generates the OneTablet **Management API** OpenAPI document straight
from the webpieces contract (`libraries/openapi-from-webpieces`, ONE-2615), and renders a
partner-facing reference site from that document (`libraries/openapi-docs-site`, ONE-2650). The
whole point of generating rather than authoring is that **the docs cannot describe an API we do not
serve.**

Every part of the document is derived from the contract — paths, operations, request and response
schemas, enums, descriptions — with exactly one exception.

## Symptom

`@AuthApiKey` takes only a regime name:

```ts
export function AuthApiKey(name: string): ClassDecorator;
```

```ts
@AuthApiKey(MANAGEMENT_API_KEY_REGIME)
@ApiPath('/management/orders')
export abstract class OrdersApi { ... }
```

`MANAGEMENT_API_KEY_REGIME` is an opaque string naming a *lookup regime*. It says nothing about
**where the credential rides** — header vs bearer, and under what header name. So a generator
reading route metadata has nothing to turn into an OpenAPI `securityScheme`, which requires exactly
that:

```yaml
type: apiKey
in: header          # <- unavailable
name: x-api-key     # <- unavailable
```

The consequence, in our repo today: `components.securitySchemes` is **hand-written** into
`libraries/apis/partner-apis/management-api/openapi.manifest.json`, and the generator copies it
through verbatim (`SpecManifest.ts` → `WebpiecesSpecGenerator.ts`; the comment there is explicit —
*"Only `securitySchemes` is read"*).

So the header names now live in **two** places with nothing tying them together:

| Where | What it says | Who reads it |
|---|---|---|
| `ManagementApiKeyHook.ts` | `const API_KEY_HEADER = 'x-api-key'`<br>`const ORGANIZATION_ID_HEADER = 'x-organization-id'` | the running server — enforcement |
| `openapi.manifest.json` | `securitySchemes.ApiKeyAuth.name: 'x-api-key'`<br>`securitySchemes.OrganizationId.name: 'x-organization-id'` | the spec, and every partner reading the docs |

Rename the header in the hook and the published contract keeps advertising the old one. Nothing
fails. The build is green. Partners send a header the server no longer reads.

## Why the one-argument form cannot simply gain a `headerName: string`

Two OpenAPI schemes are reachable from "an API key", and they are structurally different documents:

```yaml
# in: 'header'                    # in: 'bearer'
type: apiKey                      type: http
in: header                        scheme: bearer
name: x-api-key                   # (no `name` — the location IS Authorization)
```

A single optional `headerName` makes the contradictory combination *representable*
(`{in: 'bearer', name: 'x-api-key'}`), and a generator handed that has to either guess or emit a
silently-wrong spec. A **discriminated union** makes it unrepresentable:

```ts
type ApiKeyLocation =
  | { regime: string; in: 'header'; name: string }
  | { regime: string; in: 'bearer' };

export function AuthApiKey(location: ApiKeyLocation): ClassDecorator;
```

This much is already described in an existing backlog item. **This request is that item plus the
part that item does not cover.**

## The part that is missing: authentication here is a PAIR, not a credential

The Management API is not "an API key". It is **a key AND an organization id, validated together**
— the key names a customer, the org id names which of that customer's organizations the request
acts on, and a mismatch is a 401. `ManagementApiKeyHook` reads both headers and stamps the resolved
org into `RequestContext` (`OneTabletKey.ORG_ID`).

A discriminated union over ONE credential location still cannot express that. Its OpenAPI form is
two schemes plus a **security requirement that ANDs them**:

```yaml
components:
  securitySchemes:
    ApiKeyAuth:      {type: apiKey, in: header, name: x-api-key}
    OrganizationId:  {type: apiKey, in: header, name: x-organization-id}
security:
  - ApiKeyAuth: []          # <- one object, two keys = AND
    OrganizationId: []      #    (a LIST of objects would mean OR)
```

That AND-vs-OR distinction is load-bearing and easy to get wrong by hand: as a list of two objects
it means "either one suffices", which would tell every partner the org header is optional. Ours is
currently correct only because a human typed it correctly once.

So the decorator needs to accept **one or more** credential locations for a regime, and the
generator needs to emit them as a single AND-ed requirement.

## Proposed shape

```ts
type ApiKeyCredential =
  | { in: 'header'; name: string; description?: string }
  | { in: 'bearer'; description?: string };

export function AuthApiKey(regime: string, credentials: [ApiKeyCredential, ...ApiKeyCredential[]]): ClassDecorator;
```

- **Declaration-only**, exactly as the sibling backlog item scopes it: the framework still does not
  read the headers. `ApiKeyHook` keeps the whole request and keeps its own pair-check. This adds
  *description* of the credential, not *handling* of it — so it cannot regress any running auth.
- **Breaking, no shim.** A silently-optional second argument would let a contract compile while
  producing a spec with no security block, which is the failure mode being fixed. Per webpieces
  convention, no `@deprecated` one-arg overload left behind.
- `description` on each credential is worth carrying: it is what the docs site renders on its
  AUTHORIZATION card, and it is prose that belongs next to the declaration rather than in a
  hand-maintained JSON file.

## Verification

- Compile assertions that the old one-argument form fails to compile.
- Compile assertions that `{in: 'bearer', name: '...'}` fails to compile.
- Compile assertion that an empty credentials array fails to compile.
- A generator test reading location off route metadata and emitting: `type: apiKey`+`in: header`+
  `name` for the header form, `type: http`+`scheme: bearer` for the bearer form, and — for two
  credentials — ONE security-requirement object with TWO keys, not two objects.

## What we will do downstream regardless

Until this lands we intend to add a conformance test in `monorepo-nx` asserting that the manifest's
`securitySchemes[*].name` values equal `ManagementApiKeyHook`'s header constants — closing the drift
with a test rather than a type. That guard is a workaround for this gap, and should be deleted when
the decorator can carry the information.
