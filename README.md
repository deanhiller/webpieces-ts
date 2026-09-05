# WebPieces TypeScript

**Two things ship from this repository, and the second is the larger one:**

1. **A microservices framework** — a TypeScript port of [WebPieces](https://github.com/deanhiller/webpieces),
   bringing enterprise-grade microservice patterns to Node.js/TypeScript.
2. **An organizational engineering practice, and the machine that enforces it** — a set of
   conventions (feature testing, one API contract, error/context discipline, a gated git workflow)
   plus a three-stage enforcement layer (edit-time AI hooks, build-time code rules, a PR gate) that
   makes teams *and their AI agents* follow them. This layer ships to npm separately and is
   adoptable **without** the framework. If you are here to assess *scope*, that is the product — read
   [`docs/ENGINEERING-PRACTICE.md`](./docs/ENGINEERING-PRACTICE.md) first.

## Overview

WebPieces-TS is a TypeScript framework for building testable, maintainable microservices — and,
around it, a config-driven practice layer that scales code and process quality across teams. As a
framework it provides:

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
pnpm exec vitest run <path>            # one spec file or directory — what you want while iterating
pnpm nx run <project>:test             # one project
```

A bare `pnpm test` runs every spec in the workspace. That is a once-before-the-PR command, not an
inner-loop one, and it is blocked for AI agents (see `.claude/rules/build-verification.md`).

### Build

```bash
pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)   # affected projects only
pnpm nx run <project>:build                                             # one project
```

## Architecture

> **Deep dives:** the [`docs/architecture/`](./docs/architecture/README.md) folder explains the
> four load-bearing ideas that make this framework unusual — [one API contract driving four
> transports](./docs/architecture/one-contract-many-transports.md) (HTTP, in-process, browser,
> Cloud Tasks), the [request-context model](./docs/architecture/context-propagation.md) that
> propagates across async, process, and *queue* boundaries, [edge logging &
> record/replay test generation](./docs/architecture/observability-and-recording.md), and the
> [compile-time vs. inferred-runtime dependency graphs](./docs/architecture/dependency-graphs.md).
> Start there if you are an AI or new engineer trying to understand *why* the code is shaped this way.
>
> **Adopting it incrementally:** [API-first vs. the codegen
> cascade](./docs/architecture/api-first-vs-codegen.md) (one contract, no `server → gen api → gen
> client` rebuild chain) and [running alongside
> Express](./docs/architecture/express-coexistence.md) (embed webpieces route-by-route next to your
> existing framework). See [`docs/ADOPTION.md`](./docs/ADOPTION.md) for the production track record.
>
> **The engineering practice, not just the framework:**
> [`docs/ENGINEERING-PRACTICE.md`](./docs/ENGINEERING-PRACTICE.md) — the org-level conventions
> (feature testing append-only, one contract, error/context discipline, a gated git workflow) and the
> three-stage machine that enforces them on humans *and* AI agents: edit-time PreToolUse hooks,
> build-time code rules, and a PR gate, with a `mode` × `epoch` ratchet that installs a convention
> into a legacy codebase without a migration project. This layer ships to npm separately and is
> adoptable **without** the framework.

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
import { WebAppMeta } from '@webpieces/http-routing';
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

**Why no XFuture?** In Java, ThreadLocal doesn't propagate across `CompletableFuture` boundaries, so WebPieces needed `XFuture` to manually copy context. In TypeScript, `AsyncLocalStorage` handles this automatically for **all** Promises, callbacks, and async/await. Just use native Promise!

The one case it does not cover is work whose async chain was **broken and re-rooted** somewhere else — a job pushed onto an in-memory queue during a request and drained later by a background loop, a batch flushed on a scheduler tick, a listener fired from a socket the request does not own. There, capture at hand-off and restore at execution:

```typescript
const captured = RequestContext.copyContext();                     // where the work is enqueued
queue.push(() => RequestContext.runWithContext(captured.withTrusted(), () => doWork()));  // where it runs
```

`copyContext()` is the ONLY way to obtain a `CapturedContext`, and a narrowing of one is the only thing the restore side accepts. That is deliberate: a restored context legitimately contains **trusted** values, so its contents can't be type-checked — making the payload opaque is what stops a hand-assembled `Map` from forging one.

A bare `CapturedContext` is **not** accepted by `runWithContext`/`restoreContext`. You must say `.withTrusted()` (the work runs AS that user) or `.withoutTrusted()` (it runs as the system). Neither is shorter than the other, so a user identity never crosses a scope boundary by omission, and `grep -rn withTrusted` / `grep -rn withoutTrusted` enumerate the two populations of call sites.

The opposite case is work that must **not** inherit the ambient context — a browser-log line whose
context was captured on ANOTHER machine, where stamping the shipping request's `actionId` onto it would
silently destroy the ability to grep an action. That is `runDetachedScope`: a fresh, empty, nestable
scope whose values are written **inside** the closure with the ordinary trust verbs.

```typescript
RequestContext.runDetachedScope(() => {
  RequestContext.putUntrusted(ACTION_ID, line.actionId);   // nothing inherited; nothing else present
  log.info(line.message);
});
```

No container of values crosses the boundary — there is no Map/object-taking form, on purpose. Writing
the values inside is what keeps the trust verbs in play: a loop over a mixed `AnyContextKey[]` must
branch on `key.isTrusted()` before it can write anything, and `putUntrusted` does not compile for a
trusted key, so code fed by a **browser** — which proves nothing — cannot fabricate a proven value. That
is a limit on the SOURCE, not on the key: `putTrusted` inside a detached scope is ordinary and correct
when the caller HAS proven the value (a verified JWT claim, or a signed webhook whose phone number the
app looked up to a userId).

### Three cases, and how to pick

| you have | you want | write |
|---|---|---|
| a genuine prior scope | all of it, trusted values included | `runWithContext(snapshot.withTrusted(), fn)` |
| a genuine prior scope | the trace fields but NOT the identity | `runWithContext(snapshot.withoutTrusted(), fn)` |
| values from OUTSIDE this process | exactly what you re-state, nothing inherited | `runDetachedScope(fn)` |

Row 2 is a deliberate **privilege drop**: a background job spawned during a request should keep
`requestId`/`actionId` so its log lines stay greppable back to the click, and must lose
`userId`/`orgId`/roles because it runs as the **system**, not as that user.

```typescript
const snapshot = RequestContext.copyContext();
queue.push(() => RequestContext.runWithContext(snapshot.withoutTrusted(), () => doWork()));
```

Both are non-mutating transforms on the snapshot, not a flag on the run call — a `keepTrusted: boolean`
would make both intents equally easy to type and impossible to grep, and a defaulted one would make the
permissive branch the shortest thing to write. `withoutTrusted()` needs no capability token, unlike
`capture`: it only ever REMOVES entries, and dropping can never forge. What survives a drop is exactly
"registered as an UNTRUSTED `ContextKey`" — the framework's unregistered reserved slots (the
`HttpRequest`, the AuthFilter principal) go too, since a drop that guessed permissively would not be
one.

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

The `apps/app-example/client-server` demonstrates a complete microservice:

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

Error response customization and breaking migration: [Application error translation](docs/error-translators.md).
