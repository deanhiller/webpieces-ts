# One API Contract → Four Transports

> **The single most important architectural idea in webpieces-ts.** A decorated API contract is
> declared **once**. From that one declaration the framework drives four completely different
> transports — HTTP, in-process, browser, and a Cloud Tasks queue — with **no code generation**.
> The server implements the contract once; every caller everywhere reuses it.

Most teams write a contract, then hand-write (or codegen) a separate client for the browser, a
separate mock for tests, and a separate producer/consumer pair for their queue. Here there is
exactly one artifact, read by everyone.

---

## The contract

A contract is an abstract class decorated with the shared api decorators
(`packages/core/core-util/src/http/decorators.ts`): `@ApiPath`, `@Post`/`@Get`/…, and an auth mode
(`@AuthPublic`, `@AuthJwt`, `@AuthSharedSecret`, …). For a pub-sub/task contract it is additionally
marked `@PubSub` with a queue name. The decorators attach runtime metadata that every transport
reads back.

The contract carries **no implementation** — it is the compile-time interface *and* the runtime
metadata simultaneously. Both the client proxies and the server router read the same decorators.

---

## Transport 1 — HTTP (Node service → Node service)

`packages/http/http-client-node/src/NodeProxyClient.ts` extends the shared
`packages/http/http-client-core/src/ProxyClient.ts`. It marshals the call over `fetch`, attaches
propagated context as headers (`buildOutboundHeaders()`, see
[`context-propagation.md`](./context-propagation.md)), and attaches per-hop credentials separately
so they never leak. The server side is `packages/http/http-server/src/ExpressWrapper.ts` +
`WebpiecesMiddleware.ts`, which run the request through the full filter chain.

## Transport 2 — In-process (tests, zero HTTP, real filter chain)

`ApiClientFactory` (`packages/http/http-routing/src/ApiClientFactory.ts`) builds a proxy that runs
the call through the **same filter chain** (auth, logging, everything) *without* HTTP. This is the
keystone for testing:

> The same filter chain runs in-process for tests and over HTTP — so tests exercise **real** auth
> and logging, not a stub path.

`ApiClientFactory.requireActiveContext` deliberately refuses to auto-manufacture a
`RequestContext`, because doing so would hide a missing top-level filter — a bug it wants loud, not
papered over. See `apps/app-example/client-server/src/test/Authentication.spec.ts` for real JWT /
OIDC / shared-secret flows exercised entirely in-process.

## Transport 3 — Browser / Angular

`packages/http/http-client-browser/src/BrowserProxyClient.ts` +
`ClientHttpBrowserFactory.ts` implement the **identical** contract from the frontend. The Angular
app wires the same `@webpieces/client-server-api` package the server implements —
`apps/app-example/angular-site/src/app/app.config.ts` binds `SaveApi`/`PublicApi` as browser HTTP
proxies. Because the browser has no `AsyncLocalStorage`, it uses `MutableContextStore` for context
instead of `RequestContext`, but the key schema (the shared `HeaderRegistry`) is the same.

## Transport 4 — Cloud Tasks / pub-sub (fire-and-forget, across a queue)

`packages/cloud/cloudtasks-client/src/TaskProxyClient.ts` is explicitly the **enqueue twin** of the
HTTP `ProxyClient`:

> "The fire-and-forget twin of http-client-core's ProxyClient … Calling an endpoint ENQUEUES a
> task (it does not call remotely); the task is later delivered to the same endpoint's controller
> through the full server filter chain." — `TaskProxyClient.ts`

`init(apiClass, config)` validates the *same* decorators as HTTP (`assertPubSubConventions`,
`assertEveryEndpointHasAuthMode`, reads `getApiPath`/`getEndpoints`/`getAuthMode`/`getQueueName`).
The `TaskInvoker` contract is bound to a default impl exactly like the HTTP pattern:
- `GcpTaskInvoker` (`@provideFrameworkSingletonDefaultForApi(TaskInvoker)`) — real
  `@google-cloud/tasks`, OIDC or shared-secret delivery auth, dedup via deterministic task name.
- `InMemoryTaskInvoker` — local dev/tests, delivers over **real HTTP** to the target's real filter
  chain (not in-process), so localhost behaves like production.

So the producer enqueues against the contract; the consumer service *implements* the same contract
and receives the delivered task through its normal routing + filters. One contract, both ends.

---

## Why this is unusual (and hard to get right)

- **No codegen, no drift.** There is no generated client to regenerate, no mock to keep in sync,
  no separate producer/consumer schema. Rename a method on the contract and every transport breaks
  at compile time in one place.
- **Tests go through the real stack.** Because the in-process transport reuses the filter chain,
  an integration test and a production request differ only in the transport, not the logic.
- **The queue is just another transport.** Enqueuing a Cloud Task is the same programming model as
  calling an HTTP endpoint — and context + logging ride along identically (next two docs).

### Source map
| Transport | Client | Server / delivery |
|---|---|---|
| HTTP | `http-client-node/src/NodeProxyClient.ts` | `http-server/src/ExpressWrapper.ts`, `WebpiecesMiddleware.ts` |
| In-process | `http-routing/src/ApiClientFactory.ts` | same filter chain, no HTTP |
| Browser | `http-client-browser/src/BrowserProxyClient.ts`, `ClientHttpBrowserFactory.ts` | (calls a Node service) |
| Cloud Tasks | `cloudtasks-client/src/TaskProxyClient.ts` | `GcpTaskInvoker.ts` / `InMemoryTaskInvoker.ts` → target filter chain |
| Shared base | `http-client-core/src/ProxyClient.ts` | — |
| Contract decorators | `core-util/src/http/decorators.ts` | read by both sides |
