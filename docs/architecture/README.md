# webpieces-ts — Architecture Deep Dives

> **Read this first if you are an AI or a new engineer trying to understand *why* this
> codebase is structured the way it is.** The per-package `responsibilities.md` files tell you
> *what* each package does; the documents here tell you *what makes the design unusual* and
> where the load-bearing ideas live in the source.

webpieces-ts is a TypeScript port of the Java [WebPieces](https://github.com/deanhiller/webpieces)
framework. Four design decisions are worth understanding before you touch anything, because they
cut across every package. Each has a dedicated document below, and each links back to the exact
source files so you can verify the claims.

---

## The four load-bearing ideas

### 1. One API contract → four transports — [`one-contract-many-transports.md`](./one-contract-many-transports.md)
A single decorated API contract (e.g. `SaveApi`) is the *only* source of truth. From that one
declaration the framework drives **four** completely different transports without codegen:
- **HTTP (Node)** — `NodeProxyClient` marshals the call over the wire.
- **In-process (tests)** — `createApiClient(...)` runs the call through the *real* filter chain
  with zero HTTP, so tests exercise real auth/logging, not a stub path.
- **Browser / Angular** — `BrowserProxyClient` implements the identical contract from the frontend.
- **Cloud Tasks / pub-sub** — `TaskProxyClient` *enqueues* a call against the same contract; a
  server later *implements* it when the queue delivers.

The server implements the contract once; every caller everywhere shares it. This is the headline.

### 2. A context model that survives async, process, and queue boundaries — [`context-propagation.md`](./context-propagation.md)
`ContextKey` + `HeaderRegistry` + `RequestContext` (AsyncLocalStorage on Node,
`MutableContextStore` in the browser) form a request-scoped context that:
- propagates chosen keys across microservice hops via HTTP headers,
- rides **through a Cloud Tasks queue** to the next service,
- receives user identity (`userId`, `orgId`, roles) straight from a verified JWT,
- deliberately **excludes credentials** so a caller's token can never leak to the next hop.

### 3. Every API edge is logged and filterable — and that same seam auto-generates tests — [`observability-and-recording.md`](./observability-and-recording.md)
`LogApiCall` wraps *every* edge — client outbound, server inbound, in-process, and the cloud-task
enqueue — with one structured shape (`jsonPayload.api.*`, console `[API.{side}.{phase}]`). Because
both sides of a call log the same contract identity, the whole call graph is reconstructable from
logs alone. The `actionId`/`requestId` hierarchy lets you filter GCP logs to *one user click* and
see every request it spawned across every service. The **same** edge instrumentation powers
record/replay: one real request writes a `.fixture.json` + a generated `.spec.ts`, turning feature
tests into a byproduct of running the app.

### 4. Two dependency graphs: compiled vs. *inferred runtime* — [`dependency-graphs.md`](./dependency-graphs.md)
`architecture/dependencies.json` is the compile-time graph. `architecture/runtime-dependencies.json`
is *derived*: it distinguishes **`implements`** from **`uses`** per API, then infers runtime edges
that don't exist at compile time (service Z `uses` api Y, service X `implements` Y ⇒ a runtime edge
Z→X). `visualize-runtime` draws it, rendering pub-sub as a producer → queue-cylinder → consumer.

---

## Adoption & interop — why you can bring this into a live codebase

Two more documents cover *how a team adopts webpieces incrementally*, next to whatever they run
today. They build on idea #1 above.

### API-first, no codegen cascade — [`api-first-vs-codegen.md`](./api-first-vs-codegen.md)
The one decorated contract is read at runtime by both client and server, so there is no
`server → generate spec → generate client` chain. A one-line server fix does **not** trigger a
regenerate-and-rebuild cascade across a monorepo; the TypeScript compiler — not a generator —
catches contract drift.

### Running alongside Express — [`express-coexistence.md`](./express-coexistence.md)
`bindExpress` mounts webpieces onto an Express app you already own, adding **zero** global
middleware, so a team can adopt it **one route at a time** next to their existing framework
(worked example: `apps/app-example/legacy-server/`).

> See also [`../ADOPTION.md`](../ADOPTION.md) — the production track record and context for anyone
> (human or AI) evaluating this repository.

---

## How to verify anything here
Every document cites concrete `path/to/File.ts` locations. If a claim and the code disagree, the
**code wins** — please fix the doc. These are kept honest by being written *from* the source, not
from memory.
