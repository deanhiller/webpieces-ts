# Responsibilities — api-doc-model

Read a webpieces API contract with the **TypeScript compiler API** and produce ONE in-memory `ApiDocModel`. It is the single extraction pass both the OpenAPI documents and the MCP tool list are rendered from (#982), and it renders nothing itself.

It exists because **a DTO field's type is erased at runtime**. Reflection can see that `save` takes one argument; it cannot see that the argument has a `deliveryWindow` which is a discriminated union of two shapes, one carrying an ISO timestamp. Those are exactly the shapes a partner-grade document is made of, so the only place they exist is the source, and the only honest way to read the source is the compiler.

## In Scope

- ONE contract `.ts` file → the `@ApiPath` class, its `@Endpoint(path, kind, options?)` methods, and their request/response DTO graph
- **Decorator argument constant-folding** — `@Endpoint(SOME_PATH_CONST, 'rpc')` records the real path, including across an import. A const that cannot be folded is a HARD FAILURE (`ApiDocExtractionError`), never a guess: a published document that is quietly wrong about a URL is the one defect nobody catches by reading it
- Per method: path, `EndpointKind`, the `hidden` boolean, the `EndpointOptions` a document cares about (`formPost`, `calledBy`, `callerKind`), the `@WpAuth*` declaration, `@WpMcpTool` name + hints, `@WpMcpAuthJwt`, `@MaskLog`
- Per DTO: named types become model entries a renderer can `$ref`; primitives, arrays, string-literal unions → enum, **optional vs nullable distinguished** (`{}` and `{x: null}` are different wire documents), nested objects, index signature → open map
- **Cycles terminate by construction** — every named type is ONE model entry, reserved before its fields are walked. There is NO depth counter anywhere, so a deep-but-finite graph of 8 or 200 named hops is fully expanded; truncating one would publish a document quietly missing a field. Only a self-referential ANONYMOUS type is cut, and by type identity
- **A union of named object types becomes a union plus a DERIVED discriminator** when every branch carries the same property typed as a single string literal. No invented discriminator for a union TypeScript itself cannot narrow — that is recorded as an `UnmappedType` instead
- Prose: JSDoc on the class, the method and every field. `@format` lifts onto a scalar (on an array, onto the ITEM). `{@link Foo.bar}` is flattened HERE so no renderer needs to know the inline-tag grammar
- `@mcp <text>` captured as the OPTIONAL agent-facing override, per method and per field. It is left `undefined` when absent rather than defaulted, because "the author wrote an agent-facing sentence" and "we reused the human one" are different facts
- Anything unrepresentable is recorded as an explicit `UnmappedType` with the TS type text and a pointer-style location — recorded, not dropped, because #982's guard needs something to name

## Out of Scope

- Emitting OpenAPI, MCP tool definitions, or any file at all → #982. Keeping the render out is what stops the two renderers drifting apart about what the contract SAYS
- Any nx API, repo path or app-specific type
- Runtime / `reflect-metadata` introspection

## The no-app-specific-import constraint, and why it is stated here

**This package depends on `typescript` and nothing else.** That is not tidiness — it is the product. The whole reason to ship an extractor as a package rather than as a script in this repo is that it can be pointed at ANY upstream project's contract, and a single `@webpieces/core-util` import would make it unusable by anybody whose webpieces version differs from ours, which is everybody.

So decorators are matched **by NAME on the syntax**, never by importing the real decorator, and the fixtures under `src/__tests__/fixtures/` declare their own decorator stubs. If the extractor ever started needing the real decorator, those fixtures would stop producing a model and the suite would say so.

The same constraint is why failures throw `ApiDocExtractionError` and not `RuleFailError`: that type lives in `@webpieces/rules-config`. It is still a structured throw carrying `location` and `cure` as fields, and it hand-numbers nothing — the caller's renderer owns that (`.claude/review/error-output.md`).

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
