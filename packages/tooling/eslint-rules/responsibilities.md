# Responsibilities — eslint-rules

Custom ESLint plugin exporting WebPieces lint rules — architecture dependency boundaries, exception/catch-error patterns, method/file size limits, no-JsonProperty-primitive, and Angular template rules — consumed by the shared eslint config and the nx-webpieces build validators.

## In Scope

- Custom ESLint `Rule` implementations under `src/rules/*` (each an AST-visitor rule module).
- Enforcing WebPieces code patterns at lint time: `catch-error-pattern`, `no-unmanaged-exceptions`, `max-method-lines`, `max-file-lines`, `enforce-architecture`, `no-json-property-primitive-type`.
- Angular-specific template rules: `require-typed-template`, `no-mat-cell-def`.
- The `recommended` flat-config preset and the plugin `rules` map exported from `src/index.ts`.
- Shared `toError` helper used inside rule fixers/messages.

## Out of Scope

- Nx executors / build targets that *invoke* these checks — those live in `nx-webpieces-rules` (the `validate-*` executors).
- Rule mode/config resolution (ON/OFF, grace windows) — sourced from `@webpieces/rules-config` and `webpieces.config.json`, not defined here.
- PR-gate workflow CLIs and the merge dashboard — those live in `pr-gate`.
- Runtime/framework code (routing, DI, http) — this package is lint-time only.

## Notes (optional)

CommonJS package (`main: src/index.js`) so ESLint can `require()` it; `eslint` is a peer dependency. Rules read shared configuration from `@webpieces/rules-config` so lint-time and build-time gates stay consistent.
