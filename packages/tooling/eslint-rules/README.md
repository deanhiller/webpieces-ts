# @webpieces/eslint-rules

ESLint rules for WebPieces code patterns and architecture enforcement.

## Rules

- `catch-error-pattern` - Enforce toError() usage in catch blocks
- `no-unmanaged-exceptions` - Discourage try-catch outside tests
- `max-method-lines` - Enforce maximum method length (test-framework container callbacks such as `describe(...)` are exempt in `*.spec.ts` / `*.test.ts` — see below)
- `max-file-lines` - Enforce maximum file length
- `enforce-architecture` - Enforce architecture dependency boundaries
- `no-json-property-primitive-type` - Ban @JsonProperty({ type: String/Number/Boolean })
- `require-typed-template` - Require [templateClassType] on ng-template with let- variables (Angular)
- `no-mat-cell-def` - Ban *matCellDef/*matHeaderCellDef — use div-grid tables (Angular)

## `max-method-lines` and test files

A `describe('...', () => { ... })` block is a **container**, not a unit of logic — its length
only reflects how many cases a behaviour needs. Counting it as an anonymous method pushed
authors to split describe blocks purely to satisfy a limit written for production methods,
inventing structure that maps to nothing. So in **test files only**, the callback passed
directly to a test-container call is not counted.

Still counted everywhere, including in test files:

- every `it(...)` / `test(...)` body — a 200-line test case is a real finding
- `beforeEach` / `beforeAll` / `afterEach` / `afterAll` — hooks are logic, not containers
- named or assigned helper functions inside spec files
- **everything in production code** — the carve-out never applies outside a test file

Both parts are configurable:

```js
'@webpieces/max-method-lines': ['error', {
    max: 70,
    testContainers: ['describe', 'suite', 'context'],   // default
    testFilePattern: '\\.(spec|test)\\.[cm]?[jt]sx?$',  // default
}],
```

`describe.only`, `describe.skip` and `describe.each([...])(...)` all resolve to the base
container name, so they are covered by listing `describe` alone.
