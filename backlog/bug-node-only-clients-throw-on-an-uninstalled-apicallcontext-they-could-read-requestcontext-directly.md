# BUG: node-only clients throw on an uninstalled `ApiCallContext` — they already depend on `core-context` and could read `RequestContext` directly

**Packages:** `@webpieces/core-util` (`ApiCallContext`, `ApiCallContextHolder`, `LogApiCall`),
`@webpieces/core-context` (`RequestContextApiCallContext`), `@webpieces/cloudtasks-client`,
`@webpieces/http-client-node`, `@webpieces/http-routing` (`setupRuntime`)
**Version seen:** `0.4.704`
**Severity:** High — a runtime throw, on the first real call, in a service that builds and tests green.

## Symptom

`mealco-internal/monorepo-nx` `services/orders-manager` (plain NestJS, not a webpieces server) uses
`@webpieces/cloudtasks-client` to enqueue one task. Every enqueue throws:

```
Error: ApiCallContext is not installed — LogApiCall cannot tag API-call logs. Set it up ONCE at
startup: on a Node server, setupRuntime() installs it for you; in a browser, construct
ClientHttpBrowserFactory once at startup.
    at ApiCallContextHolder.get              (core-util/src/http/ApiCallContext.js:30)
    at LogApiCallImpl.activeContext          (core-util/src/http/LogApiCall.js:118)
    at LogApiCallImpl.execute                (core-util/src/http/LogApiCall.js:62)
    at TaskProxyClient.enqueue               (cloudtasks-client/src/TaskProxyClient.js:92)
```

Nothing catches this at build time. The service compiles, unit-tests pass against mocks, CI is green,
and the failure appears only when a real event is produced in a deployed environment.

## Why the seam exists — and why it does not apply to these callers

`LogApiCall` lives in `core-util`, which is `[browser, node]`, so it cannot import Node's
`RequestContext`. `ApiCallContext` is the inversion: `core-util` declares an interface, the
environment installs an implementation, and `ApiCallContextHolder.get()` throws if nobody did.
Reasonable for `core-util`.

**But the two packages that trip it are node-only and already depend on `core-context`:**

```jsonc
// packages/cloud/cloudtasks-client/package.json          (L3 · [node])
"dependencies": { "@webpieces/core-context": "workspace:*", "@webpieces/core-util": "workspace:*", ... }

// packages/http/http-client-node/package.json            (L3 · [node])
"dependencies": { "@webpieces/core-context": "workspace:*", "@webpieces/core-util": "workspace:*", ... }
```

The dependency graph confirms it: both are `L3 · [node] · designed-lib`, both reach `core-context`
(`L1 · [node]`) directly. **There is no browser-safety constraint on either.** They pay for an
abstraction that exists to protect a package they do not need protecting from — and they pay for it
with a runtime throw rather than a compile error.

## The ask — delete the GLOBAL, not the seam (SUPERSEDED shape — this is what was built)

> **Divergence, recorded on purpose.** This section originally asked for two things: (a) delete the
> process-global holder, and (b) pass the context as a per-call PARAMETER to `LogApiCall.execute()`,
> deleting `RequestContextApiCallContext` along with it. Dean reviewed that and chose a simpler shape
> that gets the same guarantee with a much smaller blast radius. (a) still stands. (b) does not: the
> context becomes a CONSTRUCTOR argument, and both env impls survive as ordinary classes. The rest of
> this file's diagnosis is unchanged and correct.

`ProxyClient` already had the injection point — `constructor(logApiCall: LogApiCallImpl = LogApiCall)`.
The global existed only to fill the gap that DEFAULT left. So:

* `LogApiCallImpl` takes its `ApiCallContext` at CONSTRUCTION: `constructor(private readonly ctx: ApiCallContext)`.
* `export const LogApiCall = new LogApiCallImpl()` is DELETED, and so is `ProxyClient`'s `= LogApiCall`
  default. A required constructor argument is what turns "forgot to bootstrap" into a COMPILE error.
* `ApiCallContextHolder` is DELETED, with both of its `install(...)` call sites
  (`setupRuntime`, `ClientHttpBrowserFactory`).
* `ApiCallContext` (the interface), `RequestContextApiCallContext` and `BrowserApiCallContext` all
  SURVIVE. They are now CONSTRUCTED by the package that needs them rather than installed process-wide.

There are exactly four construction points, one per environment entry:

| # | constructs it | package | with |
|---|---|---|---|
| 1 | `LogApiFilter` (server inbound) | http-routing | `new RequestContextApiCallContext()` |
| 2 | `NodeProxyClient` (`super(...)`) | http-client-node | `new RequestContextApiCallContext()` |
| 3 | `BrowserProxyClient` (`super(...)`) | http-client-browser | `new BrowserApiCallContext()` |
| 4 | `TaskProxyClient` | cloudtasks-client | `new RequestContextApiCallContext()` |

**Why keeping the two impls is not a shim:** they are not a second spelling of anything. There is
exactly ONE way to obtain a `LogApiCallImpl` (construct it with a context), and each package names the
one context its environment can satisfy. What was deleted is the thing that HAD two states — installed
and not-installed — and only one of them worked.

**`BrowserApiCallContext.store` must stay `private static`.** Each `BrowserProxyClient` now builds its
own instance, while a browser logger reads the tag back through the STATIC
`BrowserApiCallContext.snapshot()`. A per-instance store would silently stop tagging browser log lines;
two tests in `BrowserProxyClient.spec.ts` pin it.

That removes the same class of defect the original ask was after:

* **no process-global mutable holder.** The tests prove it: `LogApiCall.spec.ts` had 16 `install(...)`
  calls and now has zero (its recording context carries its own `LogApiCallImpl`), and three
  `http-client-node` specs each hand-rolled a private `NoopApiCallContext` — all three are gone,
  replaced by the `RequestContext.run(...)` scope those tests should have had anyway.
* **no startup requirement leaking onto library consumers.** A plain NestJS/Express host now uses
  `@webpieces/cloudtasks-client` or `@webpieces/http-client-node` with no `setupRuntime()` and no
  holder install.
* **the throw disappears** rather than being better documented.

**Honest scope note.** "No ApiCallContext bootstrap" is not "no bootstrap at all". Two things still
apply. First, the call must run inside a `RequestContext.run(...)` scope: `isActive()` is false outside
one, and LogApiCall throws on an inactive context — a different and much better message than the old
one, naming a cure the host can actually reach. Second, a non-webpieces node host must still configure
the other process-globals these clients read: `HeaderRegistry.configure(...)`,
`LogManager.setFactory(...)`, and a `ClientRegistry` url mapping or deriver (`http-client-node` THROWS
on node with no mapping and no deriver; `cloudtasks-client` derives from GCP metadata otherwise).
`ServiceInfo.setInfo(...)` is optional but unnamed builds log anonymously.

## Why a "client-only bootstrap" is the WRONG fix

The obvious smaller change is a `setupClientRuntime()` that installs the holder without building a
router. It was not done: it keeps the global, keeps the ordering requirement, and adds a second startup
path that consumers must know to call. It converts "throws if you forgot" into "throws if you forgot
the other one".

## Secondary observation: `setupRuntime` is all-or-nothing

`setupRuntime` used to be the only node path that installed the holder, and it also does
`ServiceInfo.setInfo`, `RuntimeLocality.declare`, `HeaderRegistry.configure`, `LogManager.setFactory`,
and builds a router and DI container from `AppModules`. A NestJS or Express host that wants to *use one
client* has no route table to hand it.

With the primary ask landed this no longer matters for the ApiCallContext specifically. It is recorded
because it is why two independent consumers hand-rolled their own approximations — one loading
`buildFrameworkModule()` inside the client itself, another constructing a private inversify `Container`
"the way `WebpiecesRouter.initialize` does" — both trying to reproduce a startup they had no supported
way to run. The remaining globals in the scope note above are the part of that still worth solving.

## Repro

1. In a plain NestJS (non-webpieces) service that already has a `RequestContext` open per request,
   inject `CloudTaskScheduler` from `@webpieces/cloudtasks-client` and call `addToQueue`.
2. Build and unit-test — green.
3. Deploy and trigger it — every call throws `ApiCallContext is not installed`.

## Done when (as amended above)

* `cloudtasks-client`, `http-client-node` and `http-routing` construct a `RequestContextApiCallContext`
  directly; none of them depends on an installed global — DONE
* `ApiCallContextHolder` is **deleted**, along with `export const LogApiCall` and both `install(...)`
  call sites — DONE. (`RequestContextApiCallContext` is deliberately KEPT — see the divergence note.)
* `LogApiCallImpl` receives its context as a required CONSTRUCTOR argument and cannot throw for want of
  a global — DONE
* using a node client from a non-webpieces host requires no **ApiCallContext** bootstrap — DONE; other
  process-globals still apply, see the scope note
