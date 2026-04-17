# Coding Patterns for webpieces-ts

This file contains specific coding patterns and conventions used in the webpieces-ts project. These patterns should be followed consistently when adding new features or modifying existing code.

## Table of Contents
1. [Classes vs Interfaces](#classes-vs-interfaces)
2. [Data Structure Patterns](#data-structure-patterns)
3. [Filter Chain Patterns](#filter-chain-patterns)
4. [Dependency Injection Patterns](#dependency-injection-patterns)
5. [Decorator Patterns](#decorator-patterns)
6. [Testing Patterns](#testing-patterns)

---

## Classes vs Interfaces

### The Golden Rule

**DATA ONLY → Class**
**BUSINESS LOGIC → Interface**

### Decision Tree

```
Does the type have methods with business logic?
├─ YES → Use Interface
│   └─ Examples: Filter, Routes, RouteBuilder, WebAppMeta, SaveApi
│
└─ NO → Use Class
    └─ Is it just data/configuration?
        └─ YES → Use Class
            └─ Examples: ClientConfig, FilterDefinition, RouteDefinition,
                        MethodMeta, Action, RouteMetadata
```

### Why This Matters

**Classes provide:**
1. **Explicit construction** - No anonymous object literals
2. **Validation at creation** - Enforce required fields
3. **Default values** - Set defaults in constructor
4. **Type safety** - Clear instantiation points
5. **Debuggability** - Explicit class names in stack traces

**Interfaces provide:**
1. **Polymorphism** - Multiple implementations
2. **Abstraction** - Define contracts without implementation
3. **Dependency Inversion** - Depend on abstractions

---

## Data Structure Patterns

### Pattern 1: Simple Data Class

For data with all required fields:

```typescript
export class SaveRequest {
  query: string;
  meta?: RequestMetadata;

  constructor(query: string, meta?: RequestMetadata) {
    this.query = query;
    this.meta = meta;
  }
}

// Usage
const request = new SaveRequest('search term', metadata);
```

### Pattern 2: Configuration Class with Defaults

For configuration with optional fields and defaults:

```typescript
export class JsonFilterConfig {
  validationEnabled: boolean;
  loggingEnabled: boolean;

  constructor(
    validationEnabled: boolean = true,
    loggingEnabled: boolean = false
  ) {
    this.validationEnabled = validationEnabled;
    this.loggingEnabled = loggingEnabled;
  }
}

// Usage
const config = new JsonFilterConfig(); // Uses defaults
const customConfig = new JsonFilterConfig(false, true); // Custom values
```

### Pattern 3: Metadata Class

For metadata with many optional fields:

```typescript
export class MethodMeta {
  httpMethod: string;
  path: string;
  methodName: string;
  params: any[];
  request?: any;
  response?: any;
  metadata?: Map<string, any>;

  constructor(
    httpMethod: string,
    path: string,
    methodName: string,
    params: any[],
    request?: any,
    response?: any,
    metadata?: Map<string, any>
  ) {
    this.httpMethod = httpMethod;
    this.path = path;
    this.methodName = methodName;
    this.params = params;
    this.request = request;
    this.response = response;
    this.metadata = metadata;
  }
}

// Usage
const meta = new MethodMeta(
  'POST',
  '/api/save',
  'save',
  [requestBody],
  requestData,
  undefined,
  new Map()
);
```

### Pattern 4: Extending Data Classes

When one data class extends another:

```typescript
export class RegisteredRoute<TResult = unknown> extends RouteDefinition<TResult> {
  routeMetadata?: RouteMetadata;
  controllerClass?: any;

  constructor(
    method: string,
    path: string,
    handler: RouteHandler<TResult>,
    controllerFilepath?: string,
    routeMetadata?: RouteMetadata,
    controllerClass?: any
  ) {
    super(method, path, handler, controllerFilepath);
    this.routeMetadata = routeMetadata;
    this.controllerClass = controllerClass;
  }
}
```

---

## Filter Chain Patterns

### Pattern 1: Global Filter

Applies to all routes:

```typescript
export class FilterRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    routeBuilder.addFilter(
      new FilterDefinition(140, ContextFilter, '*')
    );
  }
}
```

### Pattern 2: Path-Scoped Filter

Applies to controllers matching a pattern:

```typescript
// All admin controllers
routeBuilder.addFilter(
  new FilterDefinition(
    100,
    AdminAuthFilter,
    'src/controllers/admin/**/*.ts'
  )
);

// Specific controller
routeBuilder.addFilter(
  new FilterDefinition(
    80,
    SpecialFilter,
    '**/SaveController.ts'
  )
);

// Any controller in 'admin' directory
routeBuilder.addFilter(
  new FilterDefinition(
    90,
    AdminFilter,
    '**/admin/**'
  )
);
```

### Pattern 3: Filter Implementation

```typescript
import { injectable } from 'inversify';
import { Filter, MethodMeta, Action, NextFilter } from '@webpieces/http-filters';

@injectable()
export class MyFilter implements Filter {
  priority = 100; // Higher = executes earlier

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // 1. Pre-processing
    console.log(`Before: ${meta.httpMethod} ${meta.path}`);

    // 2. Call next filter/controller
    const action = await next.execute();

    // 3. Post-processing
    console.log(`After: ${action.statusCode}`);

    return action;
  }
}
```

### Pattern 4: Filter Priority Convention

```
140 - Context setup (ContextFilter)
120 - Request attributes
100 - Authorization/Authentication
90  - Metrics
80  - Logging
60  - JSON serialization (JsonFilter)
40  - Transactions
20  - Caching
0   - Controller execution
```

---

## Dependency Injection Patterns

### Pattern 1: Controller with Dependencies

```typescript
import { injectable, inject } from 'inversify';
import { provideSingleton, Controller } from '@webpieces/http-routing';

@provideSingleton()
@Controller()
export class SaveController extends SaveApiPrototype implements SaveApi {
  private readonly __validator!: ValidateImplementation<SaveController, SaveApi>;

  constructor(
    @inject(TYPES.Counter) private counter: Counter,
    @inject(TYPES.RemoteApi) private remoteService: RemoteApi
  ) {
    super();
  }

  override async save(request: SaveRequest): Promise<SaveResponse> {
    // Implementation
  }
}
```

### Pattern 2: Filter with Unmanaged Config

```typescript
@injectable()
export class JsonFilter implements Filter {
  constructor(
    @unmanaged() private config: JsonFilterConfig = new JsonFilterConfig()
  ) {
    // config is not injected from DI container
  }
}
```

### Pattern 3: DI Module Registration

```typescript
import { ContainerModule } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';

export class MyModule {
  getModule(): ContainerModule {
    return new ContainerModule((bind) => {
      // Manual bindings
      bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();

      // Auto-scan for @provideSingleton decorators
      // (handled by buildProviderModule)
    });
  }
}
```

---

## Decorator Patterns

### Pattern 1: API Interface Declaration

```typescript
import { ApiInterface, Post, Path } from '@webpieces/http-api';

@ApiInterface()
export abstract class SaveApiPrototype {
  @Post()
  @Path('/search/item')
  abstract save(request: SaveRequest): Promise<SaveResponse>;
}

export interface SaveApi extends SaveApiPrototype {}
export const SaveApiPrototype = SaveApiPrototype;
```

### Pattern 2: Controller Implementation

```typescript
import { Controller, provideSingleton, SourceFile } from '@webpieces/http-routing';

@SourceFile('src/controllers/SaveController.ts') // Optional: explicit filepath
@provideSingleton()
@Controller()
export class SaveController extends SaveApiPrototype implements SaveApi {
  override async save(request: SaveRequest): Promise<SaveResponse> {
    // Implementation
  }
}
```

### Pattern 3: Validation Helper

```typescript
import { ValidateImplementation } from '@webpieces/http-api';

export class SaveController extends SaveApiPrototype implements SaveApi {
  // Compile-time validator: Ensures all SaveApi methods are implemented
  private readonly __validator!: ValidateImplementation<SaveController, SaveApi>;
}
```

---

## Testing Patterns

### Pattern 1: Unit Test for Filter Matching

```typescript
import { FilterMatcher } from './FilterMatcher';
import { FilterDefinition } from '@webpieces/core-meta';

describe('FilterMatcher', () => {
  it('should match admin controllers', () => {
    const adminFilter = new MockFilter(100);

    const registry = [
      {
        filter: adminFilter,
        definition: new FilterDefinition(
          100,
          MockFilter,
          'src/controllers/admin/**/*.ts'
        ),
      },
    ];

    const result = FilterMatcher.findMatchingFilters(
      'src/controllers/admin/UserController.ts',
      registry
    );

    expect(result).toEqual([adminFilter]);
  });
});
```

### Pattern 2: Integration Test without HTTP

```typescript
import { WebpiecesServer } from '@webpieces/http-server';
import { ProdServerMeta } from '../ProdServerMeta';
import { SaveApi, SaveApiPrototype } from '../api/SaveApi';

describe('SaveApi Integration', () => {
  let server: WebpiecesServer;
  let saveApi: SaveApi;

  beforeEach(() => {
    server = new WebpiecesServer(new ProdServerMeta());
    server.initialize();
    saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
  });

  it('should process request through filter chain', async () => {
    const request = new SaveRequest('test query');
    const response = await saveApi.save(request);

    expect(response.success).toBe(true);
  });
});
```

### Pattern 3: HTTP Client Test with Mock

```typescript
import { createClient, ClientConfig } from '@webpieces/http-client';

describe('SaveApi Client', () => {
  let mockFetch: jest.Mock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = jest.fn();
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should make HTTP request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const config = new ClientConfig('http://localhost:3000');
    const client = createClient(SaveApiPrototype, config);

    const response = await client.save(new SaveRequest('test'));

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/search/item',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'test' }),
      })
    );
  });
});
```

---

## File Organization Patterns

### Package Structure

```
packages/
  core/
    core-meta/        - Core type definitions (RouteDefinition, FilterDefinition, etc.)
    core-context/     - AsyncLocalStorage context management
  http/
    http-api/         - API decorators (shared by client & server)
    http-routing/     - Server-side routing (RESTApiRoutes)
    http-client/      - Client-side HTTP client generation
    http-filters/     - Filter implementations
    http-server/      - WebpiecesServer, FilterMatcher
```

### Export Pattern

Always export from `index.ts`:

```typescript
// packages/http/http-client/src/index.ts
export { createClient, ClientConfig } from './ClientFactory';

// Re-export API decorators for convenience
export {
  ApiInterface,
  Post,
  Get,
  Path,
} from '@webpieces/http-api';
```

---

## Migration from Java Patterns

When porting features from Java webpieces:

### Java → TypeScript Equivalents

| Java | TypeScript |
|------|------------|
| `interface` (data) | `class` |
| `interface` (with methods) | `interface` |
| Guice | Inversify |
| `@Inject` | `@inject(TYPES.Something)` |
| `@Singleton` | `@provideSingleton()` |
| Package regex | Filepath glob pattern |
| `Pattern.compile("...")` | `minimatch(path, pattern)` |
| JAX-RS annotations | Decorators (`@Post`, `@Path`) |

### Common Conversions

**Java Filter:**
```java
public class MyFilter implements RouteFilter {
    @Inject
    public MyFilter(SomeService service) {
        this.service = service;
    }

    @Override
    public CompletableFuture<Action> filter(MethodMeta meta, Service<MethodMeta, Action> next) {
        // Logic
    }
}
```

**TypeScript Filter:**
```typescript
@injectable()
export class MyFilter implements Filter {
  constructor(
    @inject(TYPES.SomeService) private service: SomeService
  ) {}

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Logic
  }
}
```

---

## Anti-Patterns to Avoid

### ❌ Anonymous Object Literals for Data

```typescript
// BAD
routeBuilder.addRoute({
  method: 'POST',
  path: '/api/save',
  handler: myHandler,
});

// GOOD
routeBuilder.addRoute(
  new RouteDefinition('POST', '/api/save', myHandler)
);
```

### ❌ Interface for Data-Only Structures

```typescript
// BAD
export interface UserConfig {
  name: string;
  age: number;
}

const config = { name: 'John', age: 30 }; // Anonymous

// GOOD
export class UserConfig {
  name: string;
  age: number;

  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
}

const config = new UserConfig('John', 30); // Explicit
```

### ❌ Using 'any' Instead of 'unknown'

```typescript
// BAD
export class RouteHandler<TResult = any> {
  abstract execute(context: RouteContext): Promise<TResult>;
}

// GOOD
export class RouteHandler<TResult = unknown> {
  abstract execute(context: RouteContext): Promise<TResult>;
}
```

### ❌ Not Exporting Helper Functions

```typescript
// BAD - Helper function not exported
function jsonAction(data: any): Action {
  return new Action('json', data);
}

// GOOD - Helper function exported for reuse
export function jsonAction(data: any, statusCode: number = 200): Action {
  return new Action('json', data, statusCode);
}
```

---

## Advanced Patterns

### Pattern 1: Type-Safe API Client

The client generator creates type-safe proxies:

```typescript
// Define API interface
@ApiInterface()
export abstract class SaveApiPrototype {
  @Post()
  @Path('/search/item')
  abstract save(request: SaveRequest): Promise<SaveResponse>;
}

// Create client
const config = new ClientConfig('http://localhost:3000');
const client = createClient(SaveApiPrototype, config);

// Type-safe method call
const response: SaveResponse = await client.save(request); // ✓ Type checked
```

### Pattern 2: Filter Chain Execution

```
Request → Filter 1 (priority 140) → Filter 2 (priority 60) → Controller
            ↓                          ↓                         ↓
        wraps next                 wraps next               returns result
            ↓                          ↓                         ↓
     Response ← modifies response ← modifies response ← original result
```

Implementation:
```typescript
@injectable()
export class LoggingFilter implements Filter {
  priority = 80;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    const start = Date.now();

    // Execute next in chain
    const action = await next.execute();

    const duration = Date.now() - start;
    console.log(`${meta.httpMethod} ${meta.path} - ${duration}ms`);

    return action;
  }
}
```

### Pattern 3: Context Management with AsyncLocalStorage

```typescript
import { Context } from '@webpieces/core-context';

// In ContextFilter (priority 140 - executes first)
@injectable()
export class ContextFilter implements Filter {
  priority = 140;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    return Context.run(() => {
      Context.set('REQUEST_PATH', meta.path);
      Context.set('START_TIME', Date.now());
      return next.execute();
    });
  }
}

// In any controller or filter
const path = Context.get('REQUEST_PATH');
const startTime = Context.get('START_TIME');
```

### Pattern 4: Two-Container DI Pattern

Similar to Java WebPieces:

```typescript
export class WebpiecesServer {
  // Framework-level bindings
  private webpiecesContainer: Container;

  // Application bindings (child of webpiecesContainer)
  private appContainer: Container;

  constructor(meta: WebAppMeta) {
    this.webpiecesContainer = new Container();
    this.appContainer = new Container({ parent: this.webpiecesContainer });

    // Load user modules into app container
    const modules = meta.getDIModules();
    for (const module of modules) {
      this.appContainer.load(module);
    }
  }
}
```

---

## Filepath-Based Filter Matching

### How It Works

Similar to Java's `SharedMatchUtil.findMatchingFilters()`:

1. **Route Registration**: Controller filepath is captured during route registration
   - Uses `@SourceFile()` decorator if present
   - Falls back to class name pattern: `**/SaveController.ts`

2. **Filter Matching**: At startup, `FilterMatcher` matches filters to routes
   - Pattern `'*'` matches all controllers (global)
   - Pattern `'src/controllers/admin/**/*.ts'` matches admin controllers
   - Uses `minimatch` library for glob pattern matching

3. **Filter Chain Creation**: Matched filters are sorted by priority and cached
   - No runtime overhead - matching happens once at startup
   - Each route gets its own filter chain

### Controller Filepath Extraction

```typescript
private getControllerFilepath(): string | undefined {
  // 1. Check for explicit @SourceFile decorator
  const filepath = Reflect.getMetadata(
    ROUTING_METADATA_KEYS.SOURCE_FILEPATH,
    this.controllerClass
  );
  if (filepath) {
    return filepath;
  }

  // 2. Fallback to class name pattern
  const className = (this.controllerClass as any).name;
  return className ? `**/${className}.ts` : undefined;
}
```

### Glob Pattern Examples

```typescript
'*'                                  // All controllers (global)
'**/*'                               // All controllers (alternative)
'src/controllers/**/*.ts'            // All controllers in src/controllers
'src/controllers/admin/**/*.ts'      // All admin controllers
'**/admin/**'                        // Any file in admin directory
'**/SaveController.ts'               // Specific controller file
'apps/example-app/src/**/*.ts'       // All controllers in example-app
```

---

## Summary Checklist

When adding new code to webpieces-ts:

- [ ] Is it data-only? → Use `class`, not `interface`
- [ ] Does it have business logic methods? → Use `interface`
- [ ] Are you creating config/metadata? → Use `class` with constructor defaults
- [ ] Adding a new filter? → Implement `Filter` interface, use `@injectable()`
- [ ] Adding a new controller? → Extend API prototype, use `@Controller()` and `@provideSingleton()`
- [ ] Need to scope a filter? → Use `filepathPattern` in `FilterDefinition`
- [ ] Writing tests? → Unit tests for logic, integration tests for behavior
- [ ] Updated exports? → Add to package's `index.ts`
- [ ] Documented patterns? → Update this file if introducing new patterns

---

## Questions?

See `CLAUDE.md` for higher-level guidelines and architecture overview.
