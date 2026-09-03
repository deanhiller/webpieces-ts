# Framework patterns (webpieces-ts)

Moved verbatim out of `CLAUDE.md`. Read this when you are writing a filter, a controller, a `Routes`
class, or a test against the server, or when you need the request-path architecture overview.

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
6. **Post the PR** - The feature is not done until the PR is up (see `.claude/rules/finishing-a-feature.md`)
