# Claude Code Guidelines for webpieces-ts

This document contains guidelines and patterns for Claude Code when working on the webpieces-ts codebase.

## Core Principles

### 1. Classes Over Interfaces for Data Structures

**RULE: All data-only structures MUST be classes, not interfaces.**

**What is a data-only structure?**
- Contains only fields/properties
- No methods with business logic
- Used purely for data transfer or configuration

**Examples of DATA ONLY (use classes):**
- `ClientConfig` - Configuration data
- `FilterDefinition` - Filter metadata
- `RouteDefinition` - Route metadata
- `RouteRequest` - Request data
- `RouteContext` - Context data
- `MethodMeta` - Method metadata
- `Action` - Response data
- `RouteMetadata` - Route decorator metadata
- `JsonFilterConfig` - Configuration data
- `RegisteredRoute` - Extended route data

**Examples of BUSINESS LOGIC (use interfaces):**
- `Filter` - Has `filter(meta, next)` method with logic
- `Routes` - Has `configure(routeBuilder)` method with logic
- `RouteBuilder` - Has `addRoute()`, `addFilter()` methods
- `WebAppMeta` - Has `getDIModules()`, `getRoutes()` methods
- `SaveApi` - Has `save(request)` method with logic
- `RemoteApi` - Has `fetchValue(request)` method with logic
- `Counter` - Has `inc()`, `get()` methods with logic

**Why classes for data?**
1. No anonymous object literals - explicit construction
2. Better type safety
3. Clear instantiation points
4. Easier to trace in debugger
5. Can add validation/defaults in constructor

**Pattern:**
```typescript
// BAD - Interface for data
export interface UserData {
  name: string;
  age: number;
}

const user = { name: 'John', age: 30 }; // Anonymous object literal

// GOOD - Class for data
export class UserData {
  name: string;
  age: number;

  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
}

const user = new UserData('John', 30); // Explicit construction
```

### 2. Filter Chain Architecture

**Pattern inspired by Java webpieces:**

The filter system uses filepath-based matching:
- Filters are registered with glob patterns (e.g., `'src/controllers/admin/**/*.ts'`)
- `FilterMatcher` matches filters to routes based on controller filepath
- Filters without a pattern (or pattern `'*'`) apply globally
- Filter matching happens at startup (no runtime overhead)

**Key classes:**
- `FilterDefinition(priority, filterClass, filepathPattern)` - Filter registration
- `FilterMatcher.findMatchingFilters()` - Pattern matching logic
- `FilterChain` - Executes filters in priority order

**Example:**
```typescript
export class FilterRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    // Global filter (pattern '*' matches all)
    routeBuilder.addFilter(
      new FilterDefinition(140, ContextFilter, '*')
    );

    // Admin-only filter
    routeBuilder.addFilter(
      new FilterDefinition(100, AdminAuthFilter, 'src/controllers/admin/**/*.ts')
    );
  }
}
```

### 3. No Anonymous Object Literals

**RULE: Avoid anonymous object structures - use explicit class constructors.**

**BAD:**
```typescript
routeBuilder.addRoute({
  method: 'POST',
  path: '/api/save',
  handler: myHandler,
});
```

**GOOD:**
```typescript
routeBuilder.addRoute(
  new RouteDefinition('POST', '/api/save', myHandler)
);
```

### 4. Type Safety

- Use `unknown` instead of `any` for better type safety
- Use generics for type-safe route handlers: `RouteHandler<TResult>`
- Prefer explicit types over inference when defining public APIs

### 5. Dependency Injection

**Use Inversify for DI:**
- `@injectable()` - Mark classes as injectable
- `@provideSingleton()` - Register singleton in container (preferred over `@injectable` alone)
- `@unmanaged()` - Mark constructor params that aren't injected

**Prefer inject-by-type over Symbol tokens:**

Annotate the implementation class with `@provideSingleton()` and inject it by its concrete class type — no `Symbol()` token, no `@inject(TOKEN)` call needed:

```typescript
@provideSingleton()
export class IdentityResolver { ... }

@provideSingleton()
export class MyService {
  constructor(private readonly identityResolver: IdentityResolver) {}
}
```

**`Symbol()` DI tokens are blocked by `no-symbol-di-tokens`** (enforced via `@webpieces/ai-hook-rules` PreToolUse hook and `@webpieces/code-rules` NEW_AND_MODIFIED_CODE gate). Allowed paths are configured in `webpieces.config.json` under `no-symbol-di-tokens.allowedPaths`. Defaults:
- `libraries/apis/**` — define Symbol token alongside the API interface
- `packages/http/http-api/**` — framework primitives (e.g. `Symbol.for` multiInject)

Choose the right pattern by use case:
- **Own class** → `@provideSingleton()` + inject by type. No Symbol.
- **`libraries/apis-external/**` impl** → import the Symbol from `libraries/apis/**` and annotate with `@provideSingletonDefaultForApi(TOKEN)`. No new Symbol creation in `apis-external`.
- **External library class you cannot decorate** (DataSource, Anthropic SDK, etc.) → bind in a ContainerModule using the class itself as the token: `bind<Anthropic>(Anthropic).toDynamicValue(() => new Anthropic({...})).inSingletonScope()`. Inject by type — no Symbol, no `@inject`.
- **Unavoidable** → add `// webpieces-disable no-symbol-di-tokens -- <reason>` to the line.

### 6. Decorators

**API Decorators (shared between client and server):**
- `@ApiInterface()` - Mark API prototype class
- `@Post()`, `@Get()`, `@Put()`, `@Delete()`, `@Patch()` - HTTP methods
- `@Path('/path')` - Route path

**Server-only Decorators:**
- `@Controller()` - Mark controller class
- `@SourceFile('path/to/controller.ts')` - Explicit filepath for filter matching
- `@provideSingleton()` - Register as singleton (binds class to itself)
- `@provideSingletonDefaultForApi(TOKEN)` - Register as the default (overridable) singleton implementation of TOKEN; use in `libraries/apis-external/**` with a Symbol imported from `libraries/apis/**`

### 7. Testing

**Unit tests:**
- Test filter matching logic in isolation
- Mock dependencies using classes
- Verify priority ordering

**Integration tests:**
- Use `WebpiecesServer.createApiClient()` for testing without HTTP
- Test full filter chain execution
- Verify end-to-end behavior

### 8. Documentation

- Use JSDoc for all public APIs
- Explain WHY, not just WHAT
- Include usage examples
- Document differences from Java version when applicable

## Common Patterns

### Creating a New Filter

```typescript
import { injectable } from 'inversify';
import { Filter, MethodMeta, Action, NextFilter } from '@webpieces/http-filters';

@injectable()
export class MyFilter implements Filter {
  priority = 100;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Before logic
    console.log(`Request: ${meta.httpMethod} ${meta.path}`);

    // Execute next filter/controller
    const action = await next.execute();

    // After logic
    console.log(`Response: ${action.statusCode}`);

    return action;
  }
}
```

### Creating a New Controller

```typescript
import { provideSingleton, Controller } from '@webpieces/http-routing';

@provideSingleton()
@Controller()
export class MyController extends MyApiPrototype implements MyApi {
  private readonly __validator!: ValidateImplementation<MyController, MyApi>;

  async myMethod(request: MyRequest): Promise<MyResponse> {
    // Implementation
  }
}
```

### Registering Routes and Filters

```typescript
export class MyRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    // Register filters
    routeBuilder.addFilter(
      new FilterDefinition(140, ContextFilter, '*')
    );

    // Register API routes
    // (handled automatically by RESTApiRoutes)
  }
}
```

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                 WebAppMeta                      │
│  - getDIModules() - Returns DI modules         │
│  - getRoutes() - Returns route configurations  │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              WebpiecesServer                    │
│  - Initializes DI containers                   │
│  - Registers routes using RouteBuilder         │
│  - Matches filters to routes (FilterMatcher)   │
│  - Creates filter chains per route             │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│               FilterChain                       │
│  - Executes filters in priority order          │
│  - Wraps controller invocation                 │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              Controller                         │
│  - Implements API interface                    │
│  - Business logic                              │
│  - Returns response                            │
└─────────────────────────────────────────────────┘
```

## Key Differences from Java Version

1. **Glob patterns instead of Regex**: TypeScript uses glob patterns for filepath matching
2. **Class-based data structures**: All data structures are classes, not interfaces
3. **Decorator-based metadata**: Uses TypeScript decorators instead of annotations
4. **Inversify instead of Guice**: Different DI framework but similar patterns
5. **Class name fallback**: Since TypeScript doesn't provide source paths at runtime, we use class name patterns like `**/SaveController.ts`

## When Adding New Features

1. **Check for data-only structures** - If it's just data, use a class
2. **Add filter matching support** - Consider if filters need to scope to it
3. **Write tests first** - Unit tests for logic, integration tests for behavior
4. **Update documentation** - Keep this file and claude.patterns.md up to date
5. **Follow existing patterns** - Look at similar features for consistency
6. **Post the PR** - The feature is not done until the PR is up (see "Finishing a Feature" below)

## Build Verification (CRITICAL)

**RULE: Always run `pnpm run build-all` after making code changes.**

This command runs:
- TypeScript compilation for all packages
- ESLint checks (including custom rules like max-file-lines, no-unmanaged-exceptions)
- Circular dependency checks

```bash
pnpm run build-all
```

**Why this is critical:**
- Catches type errors across package boundaries
- Verifies ESLint rules pass (file size limits, exception handling patterns, etc.)
- Ensures no circular dependencies were introduced
- The monorepo has interdependent packages - changes in one may break others

**Do NOT:**
- Skip this step after code changes
- Assume changes are safe without verification
- Commit code that doesn't pass build-all

**A green `build-all` is NOT the finish line.** You run `build-all` many times while developing; none
of those greens mean the work is ready for review. When the feature is actually complete, proceed to
"Finishing a Feature" — do not stop at a green build.

## Finishing a Feature (CRITICAL)

**RULE: Finishing a feature MEANS posting the PR. They are the same step, not two.**

When the code is written, tests pass, and `build-all` is green, your **very next action is to post the
PR** — do NOT end your turn with "want me to open a PR?" That question is already answered: **yes,
always.** Commit your work (the tooling never commits for you), then run the gated flow:

```bash
pnpm wp-start-upsert-pr        # updates from main, pushes, runs the build gate, tells you to write review.json
# → write .webpieces/review.json (its `title` becomes the PR title)
pnpm wp-finish-upsert-pr       # authoritative build gate, then creates/updates the PR
```

The full workflow (worktrees, conflicts, the 3-point merge) is documented in
`.webpieces/instruct-ai/webpieces.git-workflow.md`, refreshed on every `wp-*` command.

Once the PR merges, clean up with `pnpm wp-cleanup` — **never `git branch -D`**:

```bash
gh pr merge --squash && git checkout main && git pull origin main && pnpm wp-cleanup
```

`wp-cleanup` deletes only provably-dead branches (merged PR, squash-merge backup of one, or no
commits of their own), spares everything else for a human, and logs each deletion with its
pre-delete SHA and a `recover=` command. Do not stop to ask whether it is safe to run — it is the
sanctioned cleanup command, and asking is what let stale branches pile up in the first place.

**The ONLY reasons to stop before posting the PR:**
- The human explicitly said "don't open a PR yet."
- The build or tests are red.

Otherwise, stopping after a green build without posting the PR is a bug — not politeness.

## Common Mistakes to Avoid

1. ❌ Using interfaces for data structures
2. ❌ Creating anonymous object literals for configs/definitions
3. ❌ Forgetting to export classes from index.ts
4. ❌ Using `any` instead of `unknown` for generic types
5. ❌ Skipping tests for new features
6. ❌ Not documenting differences from Java version
7. ❌ Stopping at a green build and asking "want me to open a PR?" instead of posting it (see "Finishing a Feature")
8. ❌ Asking "can I clean up these merged branches?" instead of just running `pnpm wp-cleanup`
