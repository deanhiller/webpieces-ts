# Responsibilities — openapi-generator

Render an `ApiDocModel` (from `@webpieces/api-doc-model`) to **OpenAPI 3.1.0**, and ship the `wp-openapi` bin. ONE render function produces every generated document.

Nothing here re-reads the source and no generated file is ever an input, so the documents — and the MCP tool list a later phase builds from one of them — cannot drift apart about what a contract says.

## In Scope

- `openapi.manifest.json` plus the contracts it names → the generated documents
- **WHICH documents exist is a property of the CONTRACTS**, via `@ApiType(...)` on each `@ApiPath` class:
  | `@ApiType` value | document | contents |
  |---|---|---|
  | `SVC_TO_SVC` | `full-private-openapi` | every method, hidden ones included, plus the internal-use-only line |
  | `EXTERNAL_CUSTOMER` | `public-openapi` | the customer contract, minus every `{ hidden: true }` method |
  | `MCP` | `mcp-openapi` | the same contracts, carrying the `x-mcp-*` extensions |
  A document no contract declares is **not written** — there is no separate emptiness rule
- `--format json|yaml|both` (default `both`) — the SERIALIZATION, orthogonal to which documents exist. Both come from the same in-memory document
- **`hidden` means ABSENT.** A hidden method has no path, no operation, no schema and no prose in the customer document. Nothing marks that something was withheld
- **Derived security** — `@WpAuthApiKey(regime, credentials)` → `components.securitySchemes` plus ONE AND-ed requirement, keyed by the manifest's published scheme names. Hoisted to the document when every operation in it is covered, stamped per operation otherwise
- **The webhook block** — a manifest entry marked `"kind": "webhook"` lands under top-level `webhooks:`, keyed by the event NAME with the `@ApiPath` base deliberately not prepended, carrying `x-webpieces-webhook: true`, documenting a `void` method as "return any 2xx to acknowledge", and contributing NOTHING to the derived security requirement
- **The document-wide error contract**, with the body read from a real TS type by the compiler
- **The folded `nameConstant` response header**, on every success response
- **The unmapped-type guard** — a refusal naming the JSON pointer of every field with no schema
- The DERIVED sentences on each operation's `description` — whether it is safe to retry, whether it reaches an external system, and (in the private document only) what triggers it — plus the operation-to-hint mapping table once in `info.description`

## Out of Scope

- Reading the source. That is `@webpieces/api-doc-model`, and keeping it out is what stops two readers disagreeing about what a contract SAYS
- MCP tool definitions, the docs site, the nx executor and the drift gate — later phases of #980
- **Any nx API, repo path or app-specific type.** It depends on `typescript`, `@webpieces/api-doc-model` and `@webpieces/core-util`, and nothing else

## Why 3.1 and not 3.0

3.1 is what the model can state HONESTLY. `type: [T, "null"]` instead of a `nullable` keyword that is not JSON Schema at all; a `description` legal beside a `$ref`, where 3.0 silently drops the prose of any field typed as a named DTO; a top-level `webhooks:` block. 3.1's schema dialect is also JSON Schema 2020-12, which is what MCP `tools/list` speaks.

## SELECT, then render — never render, then filter

One render function takes a `DocumentSelection` and is called once per document. It builds `components.schemas` by walking OUTWARD from the operations that selection accepted, so an unselected operation's DTOs are never constructed.

The asymmetry is about what a BUG does. Build-then-filter puts an unreleased feature's full request and response schemas into the document and then relies on a removal pass to take them out — so a defect in the visibility logic SHIPS them, named and fully shaped, with only the URL missing, to customers who were told the feature was withheld. Select-then-render cannot do that: no code path can emit a schema that was never built. The golden spec asserts the hidden method's TYPE NAMES are absent, not merely its path, and under this design it passes trivially — which is the point, because it can only fail if the architecture regressed.

The usual objection to rendering more than once — that the passes drift — applies to separate code paths. This is one function, so same code, same input, same output.

**Map ordering is the thing that bites.** Collecting schemas during a walk makes `components.schemas`' key order depend on which operations were walked, so two documents would list identical schemas in different orders and the goldens would churn on unrelated changes. The renderer SORTS the schema keys. Orders that carry MEANING are left alone: `apis[]` order is the published sidebar, and the security-scheme order is the order the credentials are declared in.

## Why the derived facts are PROSE and not `x-webpieces-*` extensions

Swagger UI and most themes do not render `x-` vendor extensions, and no standard generator reads `x-webpieces-*`. An extension stating the side-effect contract, the trigger kind or the credential decorator is therefore invisible to the human AND unread by the machine — the worst of both — while adding lines of noise per endpoint and churning the goldens whenever a mapping changes. So `x-webpieces-operation`, `x-webpieces-trigger` and `x-webpieces-auth` are not emitted at all; the facts become sentences on the operation's `description`, and the rule the retry sentence is derived from is published once in `info.description`.

The `x-mcp-*` extensions in `mcp-openapi.json` are the exception and stay, because that document is consumed by our own MCP server, which does read them.

Two things a document states structurally rather than in prose: `x-webpieces-webhook: true` marks an entry in the `webhooks:` block, and an endpoint declaring `@WpAuthPublic` gets `security: []` — OpenAPI's own spelling of "no credential required", where leaving the key off would instead mean "inherit the document's".

`@WpAuthLocalOnly` endpoints appear in NO document. They are not registered as routes once the process is deployed, so publishing one even internally would document a route that exists in no deployed environment — worse than omitting it, because a reader would reasonably try to call it.

## Why it emits YAML itself instead of depending on a YAML library

The value space here is exactly JSON's, because that is all an OpenAPI document holds: no dates, no anchors, no tags, no multi-document streams, no cycles — which is the entire reason a general YAML serializer is a large dependency.

Every string is **double-quoted**, deliberately. YAML's plain scalars are where its sharp edges live — `no` is a boolean, `1.0` is a number, `*x` is an alias — and a generator that quoted "only when necessary" would have to model all of those correctly forever, failing SILENTLY when it did not. A customer reading `version: 1.0` as a float is not a crash, it is a wrong document. Double-quoted YAML uses JSON's own escape grammar, so `JSON.stringify` of a string is a valid YAML scalar by construction.

`YamlReader` is the matching reader, exported for one job: a golden spec in another project proving an emitted YAML document is the same document as its JSON counterpart. It is written in the opposite direction from the writer so the two do not fail together, and it is not a general YAML parser.

## Why the document is built from `JsonObject` and not object literals

`CLAUDE.md` §3 forbids anonymous object literals, and the rule earns its keep here. This package's contract with the repo is a COMMITTED GOLDEN document that a spec regenerates and diffs. A literal's key order is whatever the code happened to type, spread over branches that each add a key conditionally, so "the same document" would render differently depending on which branch ran and the golden would go red on a change that moved nothing a reader can see. `JsonObject.set` appends in call order, so byte layout is a property of the renderer, stated in one place.

`set(key, undefined)` writes NOTHING, which lets an optional pass through without an `if` around every line — and leaves `null` available for the places 3.1 genuinely means it.

## Why the unmapped-type guard has no off switch

An unmapped type renders as an empty schema, and an empty schema in JSON Schema means "anything". A document containing one is a green build handing a customer a field with no shape — worse than no document, because nobody reads a published contract looking for the field that was quietly left undefined. So `wp-openapi` exits non-zero, names the JSON pointer of every one, and writes nothing. The cure is at the contract, by naming the type.

## The error type, and why it is not `RuleFailError`

Everything throws `OpenApiGenerationError` to the single top-level handler in `WpOpenApiMain`, which is the only renderer of a failure and the only writer of an exit code (`.claude/review/error-output.md`). `location`, `cure` and `pointers` are carried as FIELDS so the CLI renders them per audience.

`RuleFailError` lives in `@webpieces/rules-config` — the TOOLING stream, which a repo pins one release behind on purpose. `packages/docs/*` publish with the SERVER libs, so an app's `@webpieces/core-util` pin pins a generator that understands that app's decorators. Depending across the two streams to reuse an error class would couple this package's release to the rule engine's, which is the coupling the epic exists to avoid.

## Notes

Tagged `framework:node` and `role:lib`. It is in `scripts/publish-packages.sh`'s ORDER; like `api-doc-model`, `core-mock` and `mcp-server` before it, the npm NAME has to be bootstrapped once by an authenticated manual publish, because trusted publishing can publish to an existing scoped name but cannot create one.

The bin is declared in `publishConfig.bin` and never at the top level (`.claude/rules/packaging-and-bins.md`).

`apps/app-example/partner-api` is the worked example: a real contract, its manifest, and golden documents under `src/__tests__/goldens/`, with a spec that regenerates and diffs them. An app's real documents are build output, written into the outputPath of its `build` (tsc) target by the `openapi-generate` nx executor (inferred from the `generate:openapi` tag) and never committed.
