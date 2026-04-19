# @webpieces/nx-webpieces-rules Validation Rules

This document describes the validation rules provided by `@webpieces/nx-webpieces-rules` organized by when they run.

---

## Rule Enforcement Matrix

AI-hooks rules are lightweight regex/heuristic first-pass checks that run on every Write/Edit tool call. They prevent AI agents from wasting tokens by catching violations early — before the AI continues building on top of bad code and then has to waste more tokens rolling it back. Architecture-validators are the authoritative CI pass (AST/TypeChecker-based, run via `./scripts/build.sh`). AI-hooks mirrors the CI validators as a fast guard rail — CI is the last line of defense.

| Rule | ESLint (lint) | Arch-Validators (CI) | AI-Hooks (Write hook) | Doc File |
|------|:---:|:---:|:---:|---|
| max-file-lines | ✅ | ✅ `validate-modified-files` | ✅ `max-file-lines` | `webpieces.filesize.md` |
| max-method-lines | ✅ | ✅ `validate-new/modified-methods` | — | `webpieces.methodsize.md` |
| no-unmanaged-exceptions | ✅ | ✅ `validate-no-unmanaged-exceptions` | ✅ `no-unmanaged-exceptions` | `webpieces.exceptions.md` |
| catch-error-pattern | ✅ | ✅ `validate-catch-error-pattern` | ✅ `catch-error-pattern` | `webpieces.exceptions.md` |
| no-any-unknown | — | ✅ `validate-no-any-unknown` | ✅ `no-any-unknown` | — |
| no-implicit-any | — | ✅ `validate-no-implicit-any` | ✅ `no-implicit-any` | — |
| require-return-type | — | ✅ `validate-return-types` | ✅ `require-return-type` | — |
| no-inline-type-literals | — | ✅ `validate-no-inline-types` | — | — |
| no-destructure | — | ✅ `validate-no-destructure` | ✅ `no-destructure` | — |
| validate-dtos | — | ✅ `validate-dtos` | — | — |
| prisma-converter | — | ✅ `validate-prisma-converters` | — | — |
| no-direct-api-in-resolver | — | ✅ `validate-no-direct-api-resolver` | — | — |
| file-location | — | — | ✅ `file-location` | — |
| no-shell-substitution | — | — | ✅ `no-shell-substitution` | — |
| enforce-architecture | ✅ | — | — | — |
| validate-ts-in-src | — | ✅ | — | — |

---

## Section 1: Workspace-Level Validations

**Runs once via `architecture:validate-complete` before any builds.**

These validations check the entire workspace architecture and run only once, regardless of how many projects are being built.

| Rule | Description | Status |
|------|-------------|--------|
| **validate-no-architecture-cycles** | Validates no cycles exist in the project dependency graph (`architecture/dependencies.json`) | ✅ TESTED |
| **validate-architecture-unchanged** | Validates `project.json` dependencies match blessed `architecture/dependencies.json` | ✅ TESTED |
| **validate-no-skiplevel-deps** | Enforces layer hierarchy - no redundant transitive dependencies | ✅ TESTED |
| **validate-packagejson** | Validates `package.json` dependencies match `project.json` build.dependsOn | ✅ TESTED |
| **validate-new-methods** | Validates new/modified methods don't exceed max line count (git-based, affected mode) | ✅ TESTED |
| **validate-versions-locked** | Validates package.json versions are locked (no ^, ~, *) and npm ci compatible | ✅ TESTED |
| **validate-no-any-modified-code** | Validates new/modified methods don't use `any` type (git-based, affected mode) | ⏳ TODO |
| **validate-no-implicit-any** | Validates parameters/variables/properties don't infer to `any` via TS compiler (TS7006/7005/7018/etc), git-based modes: OFF / MODIFIED_CODE / MODIFIED_FILES. Escape hatch: `// webpieces-disable no-implicit-any -- reason`. Pairs with `validate-no-any-unknown` (keyword ban) — together they force real types. | ✅ WIRED |

---

## Section 2: Per-Project Validations

**Runs on each project before build via `validate-no-file-import-cycles` in build's dependsOn.**

These validations run for each project being built, checking project-specific concerns.

| Rule | Description | Status |
|------|-------------|--------|
| **validate-no-file-import-cycles** | Uses madge to check for circular file-level imports within each project | ✅ TESTED |

---

## Section 3: ESLint Rule Validations

**Runs during the `lint` target via ESLint.**

These are ESLint rules that run during linting, enforcing code quality and architecture at the file level.

| Rule | Description | Status |
|------|-------------|--------|
| **@webpieces/enforce-architecture** | Validates code imports match blessed `architecture/dependencies.json` | ✅ TESTED |
| **@webpieces/no-unmanaged-exceptions** | No `try..catch` blocks except with `eslint-disable` comment | ✅ TESTED |
| **@webpieces/catch-error-pattern** | Enforces pattern: `catch (err: unknown) { const error = toError(err); }` | ✅ TESTED |
| **@webpieces/max-method-lines** | Maximum lines per method (default: 70) | ✅ TESTED |
| **@webpieces/max-file-lines** | Maximum lines per file (default: 700) | ✅ TESTED |

---

## Section 4: AI-Hooks (Write-Tool) Validations

**Runs on every Write/Edit tool call via PreToolUse hook.**

These are lightweight regex/heuristic checks that give AI agents instant feedback before CI. They prevent token waste by catching violations early.

| Rule | Description | Status |
|------|-------------|--------|
| **no-any-unknown** | Disallow `any` keyword in new code | ✅ ACTIVE |
| **no-implicit-any** | Disallow untyped function parameters (regex heuristic) | ✅ ACTIVE |
| **max-file-lines** | Cap file length at configured limit | ✅ ACTIVE |
| **file-location** | Validate .ts files are in correct project directories | ✅ ACTIVE |
| **no-destructure** | Disallow destructuring patterns | ✅ ACTIVE |
| **require-return-type** | Require explicit return type annotations | ✅ ACTIVE |
| **no-unmanaged-exceptions** | Disallow try/catch outside chokepoints | ✅ ACTIVE |
| **catch-error-pattern** | Enforce catch (err: unknown) { const error = toError(err); } pattern | ✅ ACTIVE |
| **no-shell-substitution** | Disallow shell command substitution in Bash tool | ✅ ACTIVE |

---

## How It All Fits Together

```
Write/Edit tool call (AI agent)
  └─> AI-Hooks PreToolUse (instant feedback):
        • no-any-unknown, no-implicit-any, max-file-lines
        • no-destructure, require-return-type, file-location  
        • no-unmanaged-exceptions, catch-error-pattern
        • no-shell-substitution

build target (CI — last line of defense)
  └─> dependsOn: ["architecture:validate-complete", "validate-no-file-import-cycles", "^build"]
                       │                                    │
                       │                                    └─> Per-project: madge circular check
                       │
                       └─> Workspace-level (runs once):
                             • validate-code (runs 12 sub-validators)
                             • validate-no-architecture-cycles
                             • validate-architecture-unchanged  
                             • validate-no-skiplevel-deps
                             • validate-packagejson
                             • validate-versions-locked

lint target
  └─> ESLint rules:
        • @webpieces/enforce-architecture
        • @webpieces/no-unmanaged-exceptions
        • @webpieces/catch-error-pattern
        • @webpieces/max-method-lines
        • @webpieces/max-file-lines
```

---

## Configuration Files

| File | Purpose |
|------|---------|
| `architecture/dependencies.json` | Blessed project dependency graph (generated by `npm run arch:generate`) |
| `eslint.webpieces.config.mjs` | ESLint configuration with @webpieces rules |
| `nx.json` | Nx configuration with targetDefaults wiring validations to builds |
| `packages/tooling/nx-webpieces-rules/src/plugin.ts` | Nx inference plugin that creates validation targets |

---

## NPM Scripts

```bash
npm run build-all               # Run CI target on affected projects (runs all validations)
npm run arch:generate           # Generate architecture/dependencies.json
npm run arch:visualize          # Open interactive dependency graph
```
