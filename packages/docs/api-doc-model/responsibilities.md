# Responsibilities — api-doc-model

Read a webpieces API contract with the **TypeScript compiler API** and produce ONE in-memory `ApiDocModel`. It is the single extraction pass both the OpenAPI documents and the MCP tool list are rendered from (#982), and it renders nothing itself.

It exists because **a DTO field's type is erased at runtime**. Reflection can see that `save` takes one argument; it cannot see that the argument has a `deliveryWindow` which is a discriminated union of two shapes, one carrying an ISO timestamp. Those are exactly the shapes a partner-grade document is made of, so the only place they exist is the source, and the only honest way to read the source is the compiler.

## In Scope

- EVERY `@ApiPath` contract in one `.ts` file (`extractAll`), because a repo does not obey one-contract-per-file — `McpRemoteFixtures.ts` declares seven and the runtime registers MCP tools from all of them. `extractFile` answers the narrower question a manifest entry asks ("what is THE contract here") and is unchanged
- ONE contract `.ts` file → the `@ApiPath` class, its `@ApiType(...)` declaration, its `@Endpoint(httpMethod, path, operation, kind, options?)` methods, and their request/response DTO graph
- ONE named type from a file that holds no contract at all (`extractType`), for the document-wide error body a renderer's manifest names and no contract field points at. The SAME resolver, so there is never a second answer to what a type's shape is
- **Decorator argument constant-folding** — `@Endpoint(POST, SOME_PATH_CONST, READ, RPC)` records the real path and the real verb, including across an import, and including when the verb/operation/trigger arrive as ENUM MEMBERS rather than string literals (which is how the real decorator is called). A const that cannot be folded is a HARD FAILURE (`ApiDocExtractionError`), never a guess: a published document that is quietly wrong about a URL is the one defect nobody catches by reading it
- Per contract: `@ApiType(...)`, defaulting to `SVC_TO_SVC` alone — fail-closed, so a contract whose author typed nothing about who reads it reaches nobody but us
- Per method: HTTP verb, path, `EndpointOperation`, `EndpointKind`, the `hidden` and `openWorld` booleans from `@Endpoint`'s options (the reason a method is hidden goes in its JSDoc, where the rest of its documentation already lives), the `EndpointOptions` a document cares about (`formPost`, `calledBy`, `callerKind`), the `@WpAuth*` declaration, the `@WpMcpTool` NAME, `@WpMcpAuthJwt`, `@MaskLog`
- **The MCP biconditional**: `MCP` in `@ApiType` requires `@WpMcpTool` somewhere on the contract, and `@WpMcpTool` on a contract that does not declare `MCP` is a build failure. Membership declared in two places can disagree, and each declaration is individually valid, so the disagreement would be invisible
- `@WpAuthApiKey(regime, credentials)` is PARSED into a regime plus its ordered credentials, alone among the auth decorators, because it is the one whose argument a renderer must turn into a STRUCTURE — an OpenAPI `securityScheme` is `{type: apiKey, in, name}` or `{type: http, scheme: bearer}`, and those are different documents. Every other decorator's argument is prose or a role list a document quotes verbatim
- Per DTO: named types become model entries a renderer can `$ref`; primitives, arrays, string-literal unions → enum, **optional vs nullable distinguished** (`{}` and `{x: null}` are different wire documents), nested objects, index signature → open map
- **Cycles terminate by construction** — every named type is ONE model entry, reserved before its fields are walked. There is NO depth counter anywhere, so a deep-but-finite graph of 8 or 200 named hops is fully expanded; truncating one would publish a document quietly missing a field. Only a self-referential ANONYMOUS type is cut, and by type identity
- **A union of named object types becomes a union plus a DERIVED discriminator** when every branch carries the same property typed as a single string literal. No invented discriminator for a union TypeScript itself cannot narrow — that is recorded as an `UnmappedType` instead
- Prose: JSDoc on the class, the method and every field. `@format` lifts onto a scalar (on an array, onto the ITEM). `{@link Foo.bar}` is flattened HERE so no renderer needs to know the inline-tag grammar
- `@mcpHeader <token>` captured per field — the MCP 2026 SEP-2243 header a primitive parameter is mirrored into (`Mcp-Param-{token}`). It is a JSDoc tag because it documents one field of one wire document, and this epic's rule is that documentation has one source; the runtime spells the same fact as `WpMcpHeader` inside `@WpDtoField`, and #984 deletes that spelling
- `@mcp <text>` captured as the OPTIONAL agent-facing override, per method and per field. It is left `undefined` when absent rather than defaulted, because "the author wrote an agent-facing sentence" and "we reused the human one" are different facts
- Anything unrepresentable is recorded as an explicit `UnmappedType` with the TS type text and a pointer-style location — recorded, not dropped, because #982's guard needs something to name

## The ONE renderer that lives here: `McpSchemaRenderer`

`ApiDocModel` → `McpToolDefinition[]`, in exactly the `ApiJsonSchema` shape `DtoSchemaBuilder` produces at boot from reflect-metadata. It is here and not in a renderer package because the MCP projection is not a DOCUMENT — it is the runtime's own schema type, and the point of producing it is to compare the two.

That comparison is the equivalence gate (#983): `McpEquivalence.spec.ts` builds both schemas for a contract that declares its shape BOTH ways and asserts deep equality, and `McpRepoSweep.spec.ts` asks the same question of every `@WpMcpTool` in the repo. #984 deletes `@WpDtoField`'s erasure-repair arguments on the strength of it, and a tool whose input schema quietly loses a `required` entry fails an agent CALL rather than a build.

The renderer deliberately reproduces `DtoSchemaBuilder` rather than emitting the better schema it could:

- NULLABLE is not rendered — `ApiJsonSchema.type` holds one string, so `type: [T, "null"]` is not expressible in the type the runtime publishes
- a nested DTO is INLINED with the FIELD's prose on it, because MCP has no `$ref`
- a bound on an array of numbers lands on the ITEM, where OpenAPI puts it; the runtime cannot express it at all

Relaxing any of those to make the comparison agree would destroy the only thing the gate is for, so each is a documented reproduction and the gate's report names the difference.

## Out of Scope

- Emitting an OpenAPI document, or any FILE at all → #982. Keeping the document render out is what stops the two document renderers drifting apart about what the contract SAYS
- Any nx API, repo path or app-specific type
- Runtime / `reflect-metadata` introspection

## It IMPORTS `@webpieces/core-util`, and takes every decorator name from the real symbol

Decorators are matched by NAME on the syntax — they must be, because the extractor reads a contract with the compiler and never executes it. The question is only where that name comes from, and a string literal has a silent failure mode a symbol does not:

```ts
const ENDPOINT = Endpoint.name;   // a rename in core-util now fails to COMPILE here
```

Rename `@WpMcpTool` in `core-util` with the literal spelling and nothing stops compiling: the literal matches nothing, zero MCP tools are found, the MCP document is correctly not written because it has no tools in it, and THE BUILD IS GREEN. A customer-facing document silently loses a section with nothing red anywhere. That is issue #1001, and it is the exact class of defect this epic exists to remove, sitting inside the package whose job is to remove it.

The earlier "no import, so it works on any upstream project" justification was wrong: a contract that uses `@Endpoint` depends on `core-util` by definition, so there is no such project to protect. The import is build-time only, creates no cycle, and costs a browser bundle nothing, because nothing in a bundle imports this package. The direction that WOULD be fatal is `core-util` depending on the TypeScript compiler, and that is not this.

The same reasoning governs the FIXTURES, which now import the real decorators too. They used to declare stubs — and one of them had drifted to `@WpMcpTool({name, readOnly, idempotent})`, a shape the real decorator has never accepted, with nothing able to notice. A fixture that cannot be wrong about the thing it is a fixture FOR is not testing that thing.

`Integer` is the one name still matched as a literal, because it is a type alias and a type has no runtime symbol whose `.name` could be read.

Failures throw `ApiDocExtractionError` and not `RuleFailError` because that type lives in `@webpieces/rules-config` — the TOOLING stream, which a repo pins one release behind on purpose, while this package publishes with the SERVER libs. It is still a structured throw carrying `location` and `cure` as fields, and it hand-numbers nothing — the caller's renderer owns that (`.claude/review/error-output.md`).

## `Integer` AND `@WpInt()` — both spellings, deliberately

TypeScript has one numeric type, so integer-ness is genuinely not derivable and must be declared. Two spellings are accepted and produce IDENTICAL model output:

```typescript
limit?: Integer;                 // PREFERRED — it composes: Integer[], Record<string, Integer>
@WpInt() limit?: number;         // also accepted
```

`Integer` is preferred because a decorator on `counts?: number[]` is ambiguous about whether it describes the array or its items — the exact ambiguity the deleted `arrayItems` argument had — while `Integer[]` and `Record<string, Integer>` are not. `@WpInt()` stays for the field whose declared type you do not want to change, and because a decorator needs a class to hang on while a type alias does not.

Two things recorded honestly, because a reviewer will raise both:

1. This is a deliberate exception to `.claude/rules/no-backwards-compat.md` shim shape #1 ("two spellings of one thing"), **authorized by Dean in design review on 2026-09-22**; issue #981's body records the decision. `backwards-compat-reviewer` is a REQUIRED checklist and will flag it — the answer is to cite that authorization, not to remove a spelling.
2. It is NOT justified by an existing release. Nothing has ever shipped `@WpInt`; what shipped is `WpDtoFieldOptions`' positional `integer` argument, which #984 deletes. The reason for two spellings is **ergonomic**, not compatibility.

`@WpMin(n)` / `@WpMax(n)` on a non-numeric field is a build failure, for the same reason an unfoldable path is: dropping it silently would publish a contract weaker than the one its author wrote down.

## Notes

Tagged `framework:node` (it reads files through the compiler API) and `role:lib`. It is in `scripts/publish-packages.sh`'s ORDER; like `core-mock` and `mcp-server` before it, the npm NAME has to be bootstrapped once by an authenticated manual publish, because trusted publishing can publish to an existing scoped name but cannot create one.
