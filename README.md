# WebPieces TypeScript

A TypeScript port of the [WebPieces](https://github.com/deanhiller/webpieces) framework, bringing enterprise-grade microservice patterns to Node.js/TypeScript.

**Now available on npm!** Install with: `npm install @webpieces/http-server`

## Overview

WebPieces-TS is a TypeScript framework for building testable, maintainable microservices. Inspired by the Java WebPieces framework, it provides:

- **Auto-wiring REST APIs** - Define API interfaces with decorators, automatically wire to controllers
- **Filter Chain Architecture** - Composable filters for cross-cutting concerns (logging, validation, transactions)
- **Context Management** - Request-scoped data that flows through async operations
- **No-HTTP Testing** - Test your APIs without HTTP overhead, going through the full filter stack
- **Dependency Injection** - Built on Inversify for clean, testable code

## Quick Start

### Installation

```bash
npm install
```

### Run Tests

```bash
npm test
```

### Build

```bash
npm run build
```

## Architecture

```
packages/
├── core/
│   ├── core-context/      # AsyncLocalStorage-based context management
│   └── core-meta/         # WebAppMeta, Routes interfaces
├── http/
│   ├── http-routing/      # @Post, @Path decorators, RESTApiRoutes
│   ├── http-filters/      # Filter chain infrastructure
│   └── http-server/       # WebpiecesServer bootstrap
└── apps/
    └── example-app/       # Example microservice with SaveApi
```

## Core Concepts

### 1. WebAppMeta - Application Bootstrap

The `WebAppMeta` interface is the entry point for configuring your application:

```typescript
import { WebAppMeta } from '@webpieces/core-meta';
import { ContainerModule } from 'inversify';

export class ProdServerMeta implements WebAppMeta {
  // Define dependency injection modules
  getDIModules(): ContainerModule[] {
    return [new GuiceModule()];
  }

  // Define route configurations
  getRoutes(): Routes[] {
    return [
      new FilterRoutes(),  // Register filters
      new RESTApiRoutes(SaveApiMeta, SaveController),  // Auto-wire API → Controller
    ];
  }
}
```

### 2. API Interfaces with Decorators

Define your API contract using TypeScript interfaces and decorators:

```typescript
import { ApiInterface, Post, Path } from '@webpieces/http-routing';

// Interface for type safety
export interface SaveApi {
  save(request: SaveRequest): Promise<SaveResponse>;
}

// Decorator class for routing metadata
@ApiInterface()
export class SaveApiMeta {
  @Post()
  @Path('/search/item')
  static save(request: SaveRequest): Promise<SaveResponse> {
    throw new Error('Interface method - not called');
  }
}
```

### 3. Controllers

Implement the API interface in a controller:

```typescript
import { injectable, inject } from 'inversify';
import { Controller } from '@webpieces/http-routing';

@injectable()
@Controller()
export class SaveController implements SaveApi {
  constructor(
    @inject(TYPES.RemoteApi) private remoteService: RemoteApi,
    @inject(TYPES.Counter) private counter: Counter
  ) {}

  async save(request: SaveRequest): Promise<SaveResponse> {
    this.counter.inc();

    // Call remote service
    const result = await this.remoteService.fetchValue(request);

    // Build and return response
    const response = new SaveResponse();
    response.success = true;
    response.matches = [/* ... */];
    return response;
  }
}
```

### 4. Auto-Wiring with RESTApiRoutes

`RESTApiRoutes` uses reflection to automatically register routes:

```typescript
new RESTApiRoutes(SaveApiMeta, SaveController)
```

This:
1. Reads `@Post()` and `@Path()` decorators from `SaveApiMeta`
2. Validates that `SaveController` implements all methods
3. Registers `POST /search/item` → `SaveController.save()`

### 5. Filter Chain

Filters execute in priority order and can wrap controller execution:

```typescript
@injectable()
export class JsonFilter implements Filter {
  priority = 60;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Deserialize request
    const dto = deserialize(meta.request.body);
    meta.params[0] = dto;

    // Validate
    await validate(dto);

    // Call next filter/controller
    const action = await next();

    // Serialize response
    return serializeResponse(action);
  }
}
```

Built-in filters:
- **ContextFilter** (priority 140) - Sets up AsyncLocalStorage context
- **JsonFilter** (priority 60) - JSON serialization/validation

### 6. Context Management

Store request-scoped data that flows through async operations:

```typescript
import { Context } from '@webpieces/core-context';

// In a filter
Context.put('REQUEST_ID', generateId());

// In controller or anywhere in the async chain
const requestId = Context.get('REQUEST_ID');  // Still available!
```

Uses Node.js `AsyncLocalStorage` under the hood.

### 7. Automatic Context Propagation with AsyncLocalStorage

**Unlike Java's ThreadLocal**, Node.js `AsyncLocalStorage` automatically propagates context across ALL async boundaries - no wrapper needed!

```typescript
import { Context } from '@webpieces/core-context';

// In a filter or controller
Context.put('USER_ID', '123');
Context.put('REQUEST_ID', 'abc-def');

// Call async functions - context automatically flows!
const data = await fetchData();
const processed = await processData(data);
const saved = await saveData(processed);

// Context is STILL available in any nested async call
function async saveData(data: any) {
  const userId = Context.get('USER_ID');     // ✅ Works!
  const requestId = Context.get('REQUEST_ID'); // ✅ Works!
  // ...
}
```

**Why no XPromise?** In Java, ThreadLocal doesn't propagate across `CompletableFuture` boundaries, so WebPieces needed `XFuture` to manually copy context. In TypeScript, `AsyncLocalStorage` handles this automatically for **all** Promises, callbacks, and async/await. Just use native Promise!

## Testing Without HTTP

The killer feature: test your APIs without HTTP overhead!

```typescript
import { WebpiecesServer } from '@webpieces/http-server';

describe('SaveApi Tests', () => {
  let server: WebpiecesServer;
  let saveApi: SaveApi;

  beforeEach(() => {
    // Create server with your app metadata
    server = new WebpiecesServer(new ProdServerMeta());

    // Get API client proxy - NO HTTP!
    saveApi = server.createApiClient<SaveApi>(SaveApiMeta);
  });

  it('should save item', async () => {
    const request = new SaveRequest();
    request.query = 'test';

    // Calls SaveController.save() through full filter chain
    // No HTTP, no Express, just pure business logic + filters
    const response = await saveApi.save(request);

    expect(response.success).toBe(true);
  });
});
```

This:
- Goes through the **full filter chain** (Context, JSON, etc.)
- Invokes **real controller** with **real dependencies**
- Uses **real DI container**
- No HTTP overhead
- Fast, isolated tests

## Example Application

The `apps/example-app` demonstrates a complete microservice:

- **SaveApi** - Search API interface
- **SaveController** - Controller implementation
- **RemoteApi** - External service interface
- **GuiceModule** - DI configuration
- **ProdServerMeta** - Application bootstrap
- **Tests** - No-HTTP feature tests

Run the example:

```bash
npm start
```

Run tests:

```bash
npm test
```

## Comparison with Java WebPieces

| Java WebPieces | TypeScript WebPieces | Notes |
|----------------|----------------------|-------|
| `ProdServerMeta` | `ProdServerMeta` | Same pattern! |
| `@POST @Path` (JAX-RS) | `@Post() @Path()` | Same decorator approach |
| `XFuture<T>` | `Promise<T>` | ⭐ No wrapper needed! AsyncLocalStorage propagates automatically |
| Guice modules | Inversify ContainerModules | Same DI patterns |
| `new RESTApiRoutes(SaveApi.class, SaveController.class)` | `new RESTApiRoutes(SaveApiMeta, SaveController)` | Same auto-wiring |
| `RouteFilter` | `Filter` interface | Same filter chain pattern |
| ThreadLocal context | AsyncLocalStorage context | ⭐ Better in TypeScript - auto-propagates! |
| JPA entities | (Not implemented) | ORM will be a plugin |

## Key Design Principles

1. **Separation of Concerns** - Filters handle cross-cutting concerns, controllers handle business logic
2. **Testability** - Test without HTTP for fast, isolated tests
3. **Type Safety** - Full TypeScript support with interfaces
4. **Dependency Injection** - Loose coupling, easy mocking
5. **Context Preservation** - Request-scoped data flows through async operations
6. **Auto-Wiring** - Reduce boilerplate with decorator-based routing

## Future Work

- [ ] HTTP server implementation (Express integration)
- [ ] ORM plugin (TypeORM integration)
- [ ] Additional filters (Metrics, Logging, Authentication)
- [ ] WebSocket support
- [ ] OpenAPI/Swagger generation from decorators
- [ ] Development mode with hot-reloading

## License

ISC

## Credits

Inspired by [WebPieces](https://github.com/deanhiller/webpieces) by Dean Hiller.
