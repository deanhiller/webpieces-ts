# Responsibilities — partner-api

The WORKED EXAMPLE for `@webpieces/openapi-generator` and `@webpieces/docs-site`: a customer-facing contract written the way a real one would be, its `openapi.manifest.json`, the golden documents the generator must keep producing, and the prose a docs site publishes.

It exists so the generator is demonstrated against source somebody could plausibly have written rather than against a fixture. Every feature of `wp-openapi` is exercised here by an ordinary-looking contract: `@ApiType` selection, a hidden operator method, derived api-key security, an outbound webhook, a document-wide error contract, and a response header named by constant.

## In Scope

- `PartnerOrdersApi` — `@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)`, three endpoints on one api-key regime, one of them `{ hidden: true }`, one of them an MCP tool
- `PartnerDeliveryWebhookApi` — the event this service SENDS to a partner's own endpoint, selected into the document's `webhooks:` block by the manifest and never by its filename
- `ApiErrors.ts` / `ResponseHeaders.ts` — the types and constants the manifest NAMES, so the published document reads them with the compiler instead of carrying copies
- `openapi.manifest.json`, `description.md`
- `src/__tests__/goldens/` — `full-private-openapi.json`, `public-openapi.json`, `mcp-openapi.json` and `mcp-tools.json`: TEST FIXTURES, the generator's expected output for this contract
- `src/__tests__/openapi-golden.spec.ts` — regenerates them, diffs them, and checks each YAML parses back to its JSON
- `docs/` — `docs.manifest.json` and the partner-facing prose it names, IN ITS ORDER, which is the second of a docs site's two ordered sources (the first is the document's own `tags[]`)
- `src/__tests__/docs-site-golden.spec.ts` — renders the `public-openapi.json` golden plus `docs/` into a site and asserts the properties a reader depends on

## Out of Scope

- Serving any of it. There is no controller and no server wiring: this is a CONTRACT, and what is under test is the document generated from it, and the site rendered from that
- COMMITTED generated documents. An app's documents are build output: `openapi-generate` writes them into the build `outputPath` and they ship inside the package (see `.claude/rules/api-docs.md`). The goldens above exist only because webpieces must prove its own generator; a consuming repo commits nothing generated
- A pinned docs site. Pinning the HTML would pin the stylesheet, the class names and the markup, none of which a partner has a contract about
- Generator behaviour with no customer-facing story. That is covered by `packages/docs/openapi-generator`'s own fixtures

## Why the goldens exist

Assertions only fail for the things somebody thought to assert. What the golden catches is the change nobody predicted in what the GENERATOR emits — a decorator gains an argument, a JSDoc sentence is reworded, a DTO field turns optional — and the output moves. That is webpieces testing webpieces, which is why only webpieces keeps goldens.

Reviewing whether a CONTRACT change moved what partners see is a different job, and it lives in the PR gate: `wp-finish-upsert-pr` generates the partner-facing document at the merge-base and at HEAD for every project declaring an `openapi-generate` target and posts the difference as a PR comment — the backstop for `hidden`, against what actually shipped rather than against a checked-in file.

Pinning the private document too keeps `hidden` tested: the spec asserts `/orders/reindex` is the complete list of what this service does not show a customer, by path and by type name.

**Only the JSON is pinned.** The spec generates BOTH formats and asserts each YAML parses back to its JSON counterpart instead.

## Notes

Tagged `framework:node` and `role:api-lib`, and `private` — it is an example, never published to npm.

The webhook contract carries `@WpAuthPublic` with a reason saying out loud that it is never served here. That is the honest declaration for a contract describing a payload we SEND: `ensure-we-are-secure` requires every `@Endpoint` to state its credential posture, and "nothing of ours serves this" is a posture worth stating in a greppable place.
