# Request Context: ContextKey, RequestContext, and Cross-Boundary Propagation

> A request-scoped context that survives **async boundaries** (AsyncLocalStorage), **process
> boundaries** (HTTP headers), and even a **Cloud Tasks queue** (task headers) — while
> deliberately refusing to carry credentials past a single hop. User identity flows in straight
> from a verified JWT. This is the machinery that makes one `actionId` traceable from a browser
> click all the way to a downstream service woken up by a queue.

---

## `ContextKey` — one key type, four behaviors

`packages/core/core-util/src/ContextKey.ts`. A single class (it replaced an older
`Header`/`PlatformHeader`/`ContextKey` split). Each key declares:

| Field | Meaning |
|---|---|
| `name` | Always set. The context storage key, the log/MDC key, and the recorder name. |
| `httpHeader?` | If set, the key is **transferred over the wire** under this header. If unset, it is context-only and never leaves the process. |
| `trust` | `'trusted'` (the framework PROVED it) or `'untrusted'` (a caller asserted it). Stated by which factory built the key — `ContextKey.trusted(name, provenance, ...)` / `ContextKey.untrusted(...)`; there is no public constructor and no default. |
| `provenance` | Required on a trusted key: WHY it is trusted, in prose. |
| `maskInLogs` | If true, the value is partially **masked** in logs (`maskForLogs`). Log redaction only — unrelated to `trust`. |
| `isLogged` | Defaults true. If false, the value is **never logged**. |

`isTransferred()` is simply `this.httpHeader !== undefined`. Masking is length-aware: `< 8` chars →
`<secure key too short to log>`; `<= 15` → `ab...`; longer → `abc...xyz`.

## `HeaderRegistry` — the single global source of truth

`packages/core/core-util/src/http/HeaderRegistry.ts`. "The single, GLOBAL source of truth for every
ContextKey the platform knows about. Port of Java webpieces' HeaderTranslation." Configured once at
startup (`HeaderRegistry.configure(svrHeaders, platformHeaders)`), it precomputes cached
collections: `getTransferredKeys()`, `getMaskedNames()`, `getLoggedKeys()`, and a case-insensitive
`findByHttpHeader()`. `configure()` runs `checkForDuplicates` and **throws** if two keys share a
`name` but disagree on flags — including on `trust`, the most security-relevant of them, since
whichever module loaded first would otherwise decide whether every reader of that key is authorizing
on a spoofable value — or share an `httpHeader` under different names. `get()` throws until
`configure()` has run — misconfiguration is loud, not silent.

### Built-in keys — `WebpiecesCoreHeaders.ts`
| Constant | `name` | `httpHeader` (wire) | Notes |
|---|---|---|---|
| `REQUEST_ID` | `requestId` | `x-request-id` | Minted by the first service to see a request without one; **propagated unchanged** thereafter. |
| `REQUEST_ID_SOURCE` | `requestIdSource` | *(context-only)* | Which service minted it; present ⇒ "I am the origin." |
| `CLIENT_VERSION` | `clientVersion` | `x-webpieces-client-version` | Transferred, but each hop **overwrites** with its own `ServiceInfo.getVersion()`. |
| `ACTION_ID` | `actionId` | `x-webpieces-actionid` | App-minted, **one per user action**; sits *above* `requestId`. Framework must **not** auto-mint one. |
| `USER_ID` | `userId` | `x-user-id` | |
| `ORG_ID` | `orgId` | `x-org-id` | The tenant / org key. |
| `USER_ROLES` | `roles` | `x-webpieces-roles` | |
| `RECORDING` | `recording` | `x-webpieces-recording` | Transferred so recording follows the request. |
| `API_CALL_INFO` | `api` | *(context-only, object-valued)* | The structured `jsonPayload.api.*` tag. Per-hop only. |
| `HTTP_METHOD` / `REQUEST_PATH` | `httpMethod` / `requestPath` | *(context-only)* | Stamped by `fillFromRequest`. |
| `CONTROLLER` / `METHOD` | `controller` / `method` | *(context-only)* | Concrete controller class + **code** method name (not the HTTP verb), stamped once per request by `LogApiFilter`. |

> There is **no** built-in key named `tenant`/`tenantId`. Org identity is `orgId` (`x-org-id`). Do
> not invent a `tenantId` core key — an app may register its own, but the framework ships `orgId`.

### The deliberate exclusion: **no credential keys**
`WebpiecesCoreHeaders` states it outright: **"NO CREDENTIAL KEYS LIVE HERE."** `authorization` and
`x-webpieces-shared-secret` were *removed* as ContextKeys, because a transferred credential key
would ride every outbound RPC and every enqueued Cloud Task onward "to services that had no
business seeing it." A credential belongs to exactly **one** hop — see the auth section below.

---

## `RequestContext` — AsyncLocalStorage on the server

`packages/core/core-context/src/RequestContext.ts`. An `AsyncLocalStorage<Map<string, any>>`-backed
singleton (the moral equivalent of Java WebPieces' `ThreadLocal` `Context`). Highlights:

- **`run(fn)` throws on nesting.** AsyncLocalStorage would happily let a second `run()` install a
  fresh empty Map that *shadows* the outer one — every outer value goes invisible and a second
  request id is minted, silently splitting a trace across two ids. The guard makes that a loud
  error: "Exactly ONE scope per request — the transport opens it."
- `getTrusted(key)`/`putTrusted(key, value)` and `getUntrusted(key)`/`putUntrusted(key, value)` read and
  write by `key.name`. The verbs are trust-typed: passing the wrong kind of key is a COMPILE error, so a
  reader can never mistake a spoofable header for a proven fact. `getAny(key)` is the key-agnostic
  serialization read (log fields, outbound headers); it has no write twin on purpose.
- **`buildLogFields()`** (string-only, masked) and **`buildStructuredLogFields()`** (object-valued
  keys survive; also injects `version` from `ServiceInfo`) iterate `getLoggedKeys()` and are what
  the logging backends read on every record. Both return an **empty** map outside a `run(...)`
  block — a log line is never worth crashing a request over.

## `MutableContextStore` — the browser, which has no ALS

`packages/http/http-client-browser/src/MutableContextStore.ts` implements the shared
`ContextReader` interface (`core-util/src/http/ContextReader.ts`) with a plain `Map<string,string>`
keyed by `key.name`. The **key schema is the same** shared `HeaderRegistry`; only the value store
differs. The browser `ContextMgr` builds outbound headers by looping `getTransferredKeys()` — with
no request-id chaining, because **"a browser ORIGINATES a trace."** This is where the `actionId`
for a click is first minted.

---

## JWT → context (authentication fills identity keys)

`packages/http/http-routing/src/filters/AuthFilter.ts` is transport-neutral: it reads the
credential off the `HttpRequest` stored in context, **never** off Express:

```ts
const authHeader = RequestContext.getRequest()?.getHeader(AUTHORIZATION_HEADER); // 'authorization'
```

`AUTHORIZATION_HEADER` is "Deliberately NOT a ContextKey." Schemes are required and disambiguated:
`Bearer` (JWT/OIDC) vs `Webpieces` (shared secret) — so a secret can't be accepted as a token.

For a `jwt` route the filter calls `jwtHook.parseJwt(token)` → `applyAuthValues(values)`. The
`AuthValues` (`AuthConfig.ts`) carry `entries: ContextTuple[]`, and **this is where claims land in
context**:

```ts
for (const entry of values.entries) { RequestContext.putTrusted(entry.key, entry.value); }
RequestContext.put(PRINCIPAL_KEY, values); // '__webpieces_principal__'
```

- `DefaultJwtHook.ts` — HS256 shared-secret user JWTs; maps `sub → userId`, `roles` claim → roles.
- `CompanyJwtHook.ts` (example app) — puts the `USER_ID` context entry explicitly and adds an
  `@AuthJwt({ allRolesAllowed: true, inOrg: true })` rule requiring an `orgId` claim:
  ```ts
  return new AuthValues(userId, roles, [new ContextTuple(WebpiecesCoreHeaders.USER_ID, userId)], claims);
  ```

So a verified JWT's identity claims become first-class context keys, which then log on every line
and (for transferred keys) propagate to the next hop — **without** the token itself propagating.

---

## Propagation across a microservice hop

`packages/core/core-context/src/RequestContextHeaders.ts` — "the magic context ↔ the wire, for a
SERVER. Both directions live here," and it fails fast outside a `run(...)` scope.

- **Outbound** `buildOutboundHeaders(destination)`: loop `getTransferredKeys()`, read each from
  context, emit under `key.httpHeader`; `x-request-id` propagates unchanged; overwrite
  `CLIENT_VERSION` with this service's version. Values are **raw** (unmasked) — this map goes on the
  wire, not into logs.

  `destination` is a `DestinationTrust`, and it is the OUTBOUND half of the trust rule below. A
  **trusted** key is emitted only when the destination endpoint authenticates its CALLER
  (`@AuthOidc` / `@AuthSharedSecret`); to a `@AuthJwt` / `@Public` / undeclared endpoint it is
  omitted, because that endpoint's `AuthFilter` is obliged to reject it — sending it would 401 our
  own request. Untrusted keys always travel. `DestinationTrust.forAuthMode(route.authMeta?.mode)` is
  the only way to build one, so the caller cannot assert a posture the route does not have, and
  there is no permissive default to fall into.
- **Inbound** `fillFromRequest(request)`: `setRequest(request)`, stamp `HTTP_METHOD`/`REQUEST_PATH`,
  loop `getTransferredKeys()` and route each header by the key's TRUST: an untrusted key is written
  straight in, a **trusted** one is stashed in `PendingWireTrust` and NOT written. This fill runs at
  transport level, BEFORE any filter, so nothing has verified the caller yet — writing a trusted value
  here would mean `getTrusted` could return a header a stranger typed. `AuthFilter` then admits the
  pending values on a route that authenticated its CALLER (`@AuthOidc`/`@AuthSharedSecret`), and on
  `@AuthJwt`/`@Public` requires an exact match from the authenticator or rejects the request. If there
  is no incoming `REQUEST_ID`, mint one and stamp `REQUEST_ID_SOURCE` from `ServiceInfo.getName()`.

The Node client (`NodeProxyClient.outboundContextHeaders(destination)`) uses the exact same
`buildOutboundHeaders(destination)`, with the destination derived from the route being called; the
server entry point (`ExpressWrapper` / `WebpiecesMiddleware`) wraps each request in
`RequestContext.run(...)` then calls `fillFromRequest`. The BROWSER twin
(`ContextMgr.buildOutboundHeaders(destination)`) applies the same rule, and never reaches the
permissive branch: `BrowserProxyClient` refuses to bind an `@AuthOidc`/`@AuthSharedSecret` contract
at all, so every browser destination is `@AuthJwt` or `@Public`.

## Propagation **through a Cloud Tasks queue**

This is the part most systems can't do. When a service enqueues a task
(`TaskProxyClient.enqueue`), it calls the **same** `buildOutboundHeaders(destination)` — with the
destination derived from the `@PubSub` endpoint's own auth mode — and hands the result to the
invoker, which writes those headers onto the delivered task. A task is delivered under an OIDC token
the invoker mints, so that endpoint authenticates its caller and the **trusted** keys (`orgId`,
`userId`) propagate through the queue exactly as they do over a direct RPC hop:

```
website (mints actionId) → server1 inbound fillFromRequest (mints requestId)
   → TaskProxyClient.enqueue → buildOutboundHeaders(destination) → GcpTaskInvoker.buildTask
   → context headers become the Cloud Task's HTTP-target headers
   → [ GCP Cloud Tasks queue ]
   → delivered as a real HTTP POST to server2's filter chain
   → server2 fillFromRequest restores actionId / requestId / orgId into its RequestContext
```

Because `actionId` is a transferred, logged key, a single `actionId` filter in GCP spans
**website → server1 → queue → server2**. Credentials do not ride along — the invoker mints fresh
per-hop delivery auth (`GcpTaskInvoker.applyAuth`, `InMemoryTaskInvoker.attachAuth`).

### The `actionId` / `requestId` hierarchy
```
actionId   (app-minted, ONE per user action, rides EVERY call of that action)
   └── 1..N requestId   (framework-minted, ONE per HTTP call)
```
One user click can fan out into N HTTP calls (say, 3). Each gets its own `requestId`; all share the
one `actionId`. Grep one `actionId` in the logs → every `requestId` it spawned, and every log line
of the whole action. Absent `actionId` ⇒ a non-action flow (system / cron / task).

---

## Logging: how context reaches every line
`buildStructuredLogFields()` is called on **every** log call by both backends —
`packages/logging/winston/src/format.ts` (`injectContextFormat`) and
`packages/logging/bunyan/src/BunyanLogger.ts` (`buildFields`). Each logged key is emitted under its
`name` as a top-level `jsonPayload.<name>` in GCP (e.g. `jsonPayload.requestId`,
`jsonPayload.actionId`, `jsonPayload.orgId`), and the object-valued `API_CALL_INFO` nests as
`jsonPayload.api.{...}`. That is what makes the whole thing filterable — see
[`observability-and-recording.md`](./observability-and-recording.md).

### Source map
| Concern | File |
|---|---|
| Key type | `core-util/src/ContextKey.ts` |
| Registry | `core-util/src/http/HeaderRegistry.ts`, `WebpiecesCoreHeaders.ts` |
| Server context (ALS) | `core-context/src/RequestContext.ts` |
| Wire ↔ context | `core-context/src/RequestContextHeaders.ts` |
| Browser context | `http-client-browser/src/MutableContextStore.ts`, `core-util/src/http/{ContextReader,ContextMgr}.ts` |
| Auth → context | `http-routing/src/filters/AuthFilter.ts`, `AuthHooks.ts`, `AuthConfig.ts`, `DefaultJwtHook.ts`; `company-svc-core/src/CompanyJwtHook.ts` |
| Through the queue | `cloudtasks-client/src/TaskProxyClient.ts`, `GcpTaskInvoker.ts`, `InMemoryTaskInvoker.ts` |
