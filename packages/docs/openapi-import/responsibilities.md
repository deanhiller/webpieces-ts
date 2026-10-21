# Responsibilities — openapi-import

Turn a vendor's OpenAPI 3.0/3.1 JSON document plus a per-vendor import file into a webpieces
`EXTERNAL_OUTBOUND` contract source file, and ship the `wp-openapi-import` bin (#1339). The reverse
direction of `@webpieces/openapi-generator` (contract → OpenAPI).

## In Scope

- Reading and validating the import file (`spec`, `contract`, `auth.vendorAuth`, `contextKeys`,
  `operations`): unknown keys, dead `contextKeys` entries and repeated operations are refused
- Reading the spec STRUCTURALLY (`SpecNode`), resolving local `$ref`s, finding each listed
  operationId, and refusing what `@Endpoint` cannot express (another verb, a non-JSON body, a body on
  GET/DELETE, Swagger 2.0)
- Emitting, deterministically: the banner, the imports, every REACHED DTO class and string enum
  (sorted, declared BEFORE the contract so decorator metadata never meets a class in its TDZ), then
  the `@ApiPath('')` class with `EXTERNAL_OUTBOUND` endpoints, `@PathParam` / `@QueryString`
  arguments, `Promise<void>` voids (no `responseBody` option — the vendor shapes outbound responses), `vendorAuth(...)` and `@ExternalContextKeys`
- Escaping vendor prose for JSDoc

## Out of Scope

- YAML and Swagger 2.0 input (convert first) — a later phase
- An nx executor: the output is committed source, regenerated on demand
- Runtime behaviour of the generated contract — that is core-util / the HTTP clients

## Dependencies

Node builtins only, so adding a vendor never grows a consumer's dependency surface.
