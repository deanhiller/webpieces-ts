# @webpieces/eslint-plugin

ESLint plugin for WebPieces code patterns and architecture enforcement.

## Rules

- `catch-error-pattern` - Enforce toError() usage in catch blocks
- `no-unmanaged-exceptions` - Discourage try-catch outside tests
- `max-method-lines` - Enforce maximum method length
- `max-file-lines` - Enforce maximum file length
- `enforce-architecture` - Enforce architecture dependency boundaries
- `no-json-property-primitive-type` - Ban @JsonProperty({ type: String/Number/Boolean })
- `require-typed-template` - Require [templateClassType] on ng-template with let- variables (Angular)
- `no-mat-cell-def` - Ban *matCellDef/*matHeaderCellDef — use div-grid tables (Angular)
