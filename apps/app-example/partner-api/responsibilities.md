# Responsibilities — partner-api

The WORKED EXAMPLE for `@webpieces/openapi-generator`: a customer-facing contract written the way a real one would be, its `openapi.manifest.json`, and the COMMITTED OpenAPI documents generated from it.

It exists so the generator is demonstrated against source somebody could plausibly have written rather than against a fixture. Every feature of `wp-openapi` is exercised here by an ordinary-looking contract: `@ApiType` selection, a hidden operator method, derived api-key security, an outbound webhook, a document-wide error contract, and a response header named by constant.

## In Scope

- `PartnerOrdersApi` — `@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)`, three endpoints on one api-key regime, one of them `{ hidden: true }`, one of them an MCP tool
- `PartnerDeliveryWebhookApi` — the event this service SENDS to a partner's own endpoint, selected into the document's `webhooks:` block by the manifest and never by its filename
- `ApiErrors.ts` / `ResponseHeaders.ts` — the types and constants the manifest NAMES, so the published document reads them with the compiler instead of carrying copies
- `openapi.manifest.json`, `description.md`
- `generated/` — the committed `full-private-openapi.json`, `public-openapi.json` and `mcp-openapi.json`
- `src/__tests__/openapi-golden.spec.ts` — regenerates them, diffs them, and checks each YAML parses back to its JSON

## Out of Scope

- Serving any of it. There is no controller and no server wiring: this is a CONTRACT, and what is under test is the document generated from it
- Generator behaviour with no customer-facing story. That is covered by `packages/docs/openapi-generator`'s own fixtures

## Why the documents are COMMITTED

Assertions only fail for the things somebody thought to assert. What the golden catches is the change nobody predicted — a decorator gains an argument, a JSDoc sentence is reworded, a DTO field turns optional — and the published customer contract MOVES. Committing the documents makes every one of those a visible diff in the PR that causes it, which is the only point at which anybody can say whether the customer-facing change was intended. A green build that silently republishes a different contract is the failure mode the generator exists to remove.

Committing the private one too is what makes `hidden` reviewable: `diff full-private-openapi.json public-openapi.json` is the complete list of what this service does not show a customer.

**Only the JSON is committed.** Committing the YAML would double the review surface every decorator change has to be diffed against, for a file that is the first one restated; the spec generates BOTH formats and asserts each YAML parses back to its JSON counterpart instead.

## Notes

Tagged `framework:node` and `role:api-lib`, and `private` — it is an example, never published to npm.

The webhook contract carries `@WpAuthPublic` with a reason saying out loud that it is never served here. That is the honest declaration for a contract describing a payload we SEND: `ensure-we-are-secure` requires every `@Endpoint` to state its credential posture, and "nothing of ours serves this" is a posture worth stating in a greppable place.
