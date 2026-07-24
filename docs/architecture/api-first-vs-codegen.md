# API-First vs. the Codegen Cascade

> **One decorated contract, read at runtime by both the client and the server — no code
> generation, and therefore no regenerate-and-rebuild cascade.** This is the property that lets a
> team edit a server without kicking off a chain reaction of spec regeneration, client
> regeneration, and downstream rebuilds. It is the deeper "why" behind
> [`one-contract-many-transports.md`](./one-contract-many-transports.md).

---

## The industry standard: `server → generate api → generate client`

The common way to keep a client and server in sync is to **generate** one from the other:

```
server code
   → emit an API spec (OpenAPI / Swagger / .proto)
      → run a generator (openapi-generator, swagger-codegen, protoc, nswag, …)
         → produce a client package (typed stubs)
            → every downstream service imports that generated client
```

Each arrow is a build step with an artifact that can go stale.

### Why this is painful in a monorepo

In a monorepo where service 1 calls service 2 calls service 3, the generated artifacts chain
together. A **one-line bug fix in server 1** ripples outward:

```
fix a line in server 1
   → regenerate server 1's api spec
      → regenerate server 1's client
         → server 2 (which imports that client) rebuilds
            → regenerate server 2's api spec
               → regenerate server 2's client
                  → server 3 rebuilds …and on down the chain
```

The generated files are real, versioned, checked-in (or CI-produced) artifacts, so the whole chain
churns: diffs balloon, versions must be bumped in lockstep, and a stale generator run silently
ships a client that no longer matches its server. The cost of a trivial change is a
disproportionate, brittle rebuild wave.

## How webpieces cuts the chain: the contract *is* the machine-read artifact

webpieces is **API-first**. The contract is a single decorated `abstract class` that lives in one
shared `*-api` package, and **both the client and the server read that same class's decorators at
runtime** — there is no intermediate spec and nothing is generated.

### The contract is the single source of truth

`apps/app-example/client-server-api/src/SaveApi.ts:92-102` says it outright:

```ts
// This class is the single source of truth for both the contract and routing metadata:
//   1. Server-side:  ApiRoutingFactory reads decorators to bind routes to controllers
//   2. Client-side:  ClientHttpFactory reads decorators to create HTTP client proxies
//   3. Controllers implement this class to get compile-time enforcement
@ApiPath('/search')
export abstract class SaveApi {
    @Endpoint('/item')
    ...
}
```

The decorators attach runtime metadata via `Reflect.defineMetadata`
(`packages/core/core-util/src/http/decorators.ts`), and both sides read it back with the same
`getApiPath` / `getEndpoints` / `getAuthMeta` importers.

### The client is built *from* the class at runtime (no generated file)

`packages/http/http-client-core/src/ProxyClient.ts` `initRoutes()` (L129) reads `getApiPath` (L135)
and `getEndpoints` (L136) off the **contract prototype** and builds its route table in memory. The
typed client itself is a JavaScript `Proxy` — `buildClientProxy.ts:49` returns
`new Proxy({}, ...)` where each method access maps to `proxyClient.getRoute(prop)` (L73) →
`proxyClient.makeRequest(...)` (L77). There is no generated stub file; the `Proxy` *is* the client.
The fetch call even carries the comment that makes the point explicit:

```ts
// this IS the generated-client implementation the rule points everyone to
```
(`ProxyClient.ts:259`)

### The server reads the *same* decorators

`packages/http/http-routing/src/ApiRoutingFactory.ts` imports the identical decorator readers (L2)
and, in its constructor, checks the runtime prototype chain to guarantee the controller actually
`extends` the api class (L48-59) — so a controller cannot silently drift from the contract.

### Both sides import one package, not a generated copy

`@webpieces/client-server-api` depends only on `@webpieces/core-util` (its `package.json`), and it
is imported unchanged by the server routing, the browser/Angular client, and node-to-node clients
alike. The **exact same class object** is on both sides; nothing is copied or regenerated.

### There is no generator to run — verified

A search of the repo finds **no** `openapi-generator`, `swagger-codegen`, `openapi-typescript`,
`nswag`, or `protoc` in any `package.json`; **no** `*.proto` files; and **no** `@generated`
markers anywhere under `packages/` or `apps/`. The `client-server-api` package has no generate
script and no spec artifact — its `src/` is just the hand-authored contract classes.

## The payoff

Because the client and server both build **from** the one imported contract at runtime, editing a
contract is a plain TypeScript source change to the single package both sides `import`:

- **No spec-emit step. No generate step.** There is nothing to regenerate, so nothing downstream is
  forced to rebuild by regeneration.
- **The TypeScript compiler is the checker, not a generator.** Add or change an `@Endpoint` and the
  compiler flags every client call site and every controller that no longer matches — instantly, in
  one build, with no generated intermediate to fall out of date.
- **The cascade is eliminated**, not merely automated. There is no chain of generated artifacts to
  version in lockstep, so a one-line fix stays a one-line fix.

---

## Verify anything here
Every claim above cites a `path/to/File.ts:line`. If a claim and the code disagree, the **code
wins** — fix the doc. See also [`one-contract-many-transports.md`](./one-contract-many-transports.md)
(the four transports this same contract drives) and
[`express-coexistence.md`](./express-coexistence.md) (adopting webpieces incrementally next to an
existing framework).
