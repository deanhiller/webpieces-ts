# @webpieces/openapi-import

Generate a webpieces **`EXTERNAL_OUTBOUND` contract** from a vendor's OpenAPI 3.0/3.1 JSON document.
The output is an `@ApiPath` abstract class with one `@Endpoint` method per operation you list, plus
every DTO class and string enum those operations reach. Bind it like any contract —
`binder.createRpcClientAndBind(VendorApi, 'vendor')` with `ClientRegistry.addUrlMapping('vendor', url)`
— and the existing `ProxyClient` does the HTTP: `LogApiCall` with `api.http.*` facts, `vendorAuth(...)`
credentials, the vendor node on the runtime architecture graph, and tests that mock the abstract class.

## The import file — one per vendor

```json
{
  "spec": "spec/vendor-openapi.json",
  "contract": "VendorApi",
  "auth": { "vendorAuth": "vendor" },
  "contextKeys": {
    "*": [{ "from": "@myorg/vendor-keys", "symbol": "VendorKeys.MERCHANT_ID" }],
    "orders.DeleteOrder": []
  },
  "operations": ["items.GetItems", "orders.DeleteOrder"]
}
```

| key | meaning |
|---|---|
| `spec` | the vendor's OpenAPI 3.0/3.1 **JSON**, relative to the import file (YAML and Swagger 2.0 are not supported yet — convert first) |
| `contract` | the generated class name |
| `auth.vendorAuth` | every endpoint declares `@WpAuth([vendorAuth('<name>')])`; your bound `VendorAuthHook` mints the credential |
| `contextKeys` | `"*"` → class-level `@ExternalContextKeys(...)` (every endpoint sends them); an operationId → method-level keys ADDED for that operation. Each entry is `{ from, symbol }`: the module and the dotted symbol to import |
| `operations` | the operationIds to generate, in contract order. The allowlist is mandatory: only what you call is generated |

Refused, each naming the fix: an unknown key, a `contextKeys` entry for an operation that is not in
`operations` (a dead entry), an operation listed twice or absent from the spec, a non-JSON request
body, a GET/DELETE with a body, and a document that is not OpenAPI 3.0/3.1.

## Run it

```bash
wp-openapi-import --config libraries/apis/external-node/vendor-api/openapi-import.json \
                  --out libraries/apis/external-node/vendor-api/src/VendorApi.generated.ts
```

The `.ts` is **100% generated and byte-identical on regeneration** — never edit it; re-run the command.
A `*.generated.ts` name (or a `generated/` directory) keeps it under the repo's generated-code
exemptions. There is no nx executor in v1: it writes committed source, run on demand.

## What it generates

- `@Endpoint(<VERB>, '<spec path>', READ | WRITE_IDEMPOTENT | WRITE, EXTERNAL_OUTBOUND)` — `GET` is
  `READ`, `PUT`/`DELETE` are `WRITE_IDEMPOTENT`, `POST`/`PATCH` are `WRITE`
- `@PathParam('<name>')` per path placeholder, in path order; the request body as the single
  unannotated argument; and, when the spec documents any query parameter, one
  `@QueryString() query?: QueryParams` — a free-form multimap, because a vendor's query grammar is the
  vendor's (the documented keys and types are listed in the method's JSDoc)
- `Promise<void>` (and no `responseBody` option: the vendor shapes an outbound response and the
  client accepts any 2xx) when the spec documents no 2xx JSON body
- DTO **classes** (`<Schema>Dto`, inline bodies `<Method>Request` / `<Method>Response`, nested inline
  objects `<Parent><Property>Dto`) and **string enums**; `allOf` is flattened, `oneOf`/`anyOf` become a
  union, `nullable` / `type: [T, "null"]` become `T | null`
- the vendor's prose as JSDoc, ESCAPED (`@` and `*/` can neither start a tag nor end the comment), a
  `@summary` per method, and a generated-file banner

Header parameters (a constant `User-Agent`, a per-call routing id) are not arguments: a constant is
your `VendorAuthHook`'s or a client filter's job, and a per-call value is a `ContextKey` listed in
`contextKeys`.
