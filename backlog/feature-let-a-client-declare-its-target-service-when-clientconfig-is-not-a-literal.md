# FEATURE: let a CLIENT declare its target service, for when ClientConfig cannot be a literal at the call site

> **STATUS (primary fix shipped):** the `callsService` declaration (acceptance checks 1–4) is
> implemented — `metadata.webpieces.callsService` on a client project resolves its untargeted `uses`
> to one service, a literal `ClientConfig` still wins, neither still fans out + warns, and a
> `callsService` pointing at a non-serving/unknown service FAILS the build. The **companion rule**
> (checks 5–8: forbid `role:lib` from calling `createRpcClient`/`createPubSubClient`) is deliberately
> deferred — it is a new build-failing code-rule that (per this repo's two-phase rule-activation) must
> ship tooling-first then be enabled via `webpieces.config.json` after publish, and the doc itself asks
> for it WARN-first with a migration path. Tracked as follow-up.


**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.464`
**Severity:** Medium-High — the runtime graph still shows **calls that cannot happen**, and the
repo cannot fix it from its side. #475 solved this for server→server; browser→server is still fiction.

## Symptom

In `acme-edu/consumer-repo3`, `helper-portal-angular` — the HELPER portal's browser bundle — is drawn
calling the LANG product's servers:

```
helper-portal-angular -> lang-fsdb-svr   : BrowserLogApi, WarmupApi          <-- fiction
helper-portal-angular -> lang-server     : AuthApi, BrowserLogApi, WarmupApi <-- fiction
helper-portal-angular -> helper-fsdb-svr : BrowserLogApi, WarmupApi          <-- fiction
helper-portal-angular -> helper-svr      : AuthApi, BrowserLogApi, ... , WarmupApi   <-- the ONLY real one
```

Different product, different GCP project, and the fsdb surface is `@AuthOidc()` service-to-service —
a browser cannot reach it. The graph is read to reason about blast radius, and it currently says a
helper-portal browser change could affect the lang data server.

Note the shape: contracts with ONE implementer (`InboxApi`, `EmailIntakeApi`, `PortalSettingsApi`, …)
resolve correctly. Only the multi-implementer, company-wide ones fan out — `AuthApi` (2 implementers),
`BrowserLogApi` (4), `WarmupApi` (4). So the more widely a framework contract is adopted, the more
fictional the picture becomes.

## Root cause: #475 needs the literal AT the call site; here it is one indirection away, in another project

`#475` resolves `createRpcClient(Api, new ClientConfig('<literal>'))`. In an Angular app the client is
built once in a SHARED library, from a config field:

```ts
// libraries/angular/core-angular/src/provide-core-client.ts
useValue: new ClientConfig(config.svcName),                  // :124  <-- variable, not a literal
factory.createRpcClient(BrowserLogApi, clientConfig),        // :131  <-- config is a REFERENCE
factory.createRpcClient(WarmupApi, clientConfig),            // :155
```

The literal does exist — but in the app, not the lib:

```ts
// services/angular/helper-portal-angular/src/app/app.config.ts:66
config.svcName = 'helper-portal';
```

This is not a code smell to be refactored away. One shared provider wiring every app's clients is the
correct design; the whole point is that `helper-portal-angular` and `lang-angular` share it and differ
only by config. Inlining a literal into the lib is impossible — it serves both apps — so **no change
in the consuming repo can fix this.** The tooling warns (correctly, and loudly since #475), but the
warning is unactionable:

```
⚠️  helper-portal-angular uses "WarmupApi" with no literal client config, and 4 services implement it
    — an edge is drawn to EVERY one, so all but one are fiction.
    Name the target: createRpcClient(WarmupApi, new ClientConfig('<serviceName>')).
```

## Suggested fix — the symmetric half of what #475 already added

#475 let the IMPLEMENTING side declare its identity:

```json
"metadata": { "webpieces": { "serviceName": "helper-fsdb" } }
```

Let the CALLING side declare its target the same way:

```json
// services/angular/helper-portal-angular/project.json
"metadata": { "webpieces": { "callsService": "helper-portal" } }
```

Resolution order for a `uses` relation:

1. a literal `ClientConfig` at the call site (today's behaviour — most specific, still wins);
2. else the calling project's declared `callsService`;
3. else today's fan-out, with the existing warning.

Most clients talk to exactly one server, so a single declaration fixes every unresolved use at once.
A client that genuinely calls several would keep using literals, or the field could accept a
`{ apiName: serviceName }` map for the mixed case.

**Alternative considered and rejected:** following the variable back to `config.svcName` requires
cross-project constant propagation through a DI provider — far more machinery, and it would still fail
whenever the value is genuinely dynamic. A declaration is honest about what it is.

## Stronger companion fix: only a SERVER or CLIENT project may create a client

The declaration above makes unresolvable uses resolvable. A rule makes them **not happen**.

Proposal: a new webpieces rule — **only projects tagged `role:server` or `role:client` may call
`createRpcClient` / `createPubSubClient`; a `role:lib` that does so FAILS THE BUILD.** A reusable
library must instead take the api **injected**, and the server/app module binds it to a client. The
client-creation site then always lives in a project that has a declared identity (`serviceName`) or a
declared target (`callsService`), so **every** edge is attributable and the runtime graph is exact by
construction rather than by remembering to annotate.

The consuming repo's data is a clean natural experiment. Every client-creation site, by project kind:

| Where created | Contracts | Graph result |
|---|---|---|
| SERVER project (`RemoteFsdbModule`), literal `ClientConfig` | HelperFsdbApi, AgentThreadsPort, AuthStoreApi, WarmupApi | correct |
| ANGULAR APP (`app.config.ts`) | ExampleApi, InboxApi, EmailIntakeApi, PortalSettingsApi, EmailSourcesApi, LangSecureApi | correct (single implementer) |
| ANGULAR LIB (`core-angular`, `auth-angular`) | **BrowserLogApi, WarmupApi, AuthApi** | **exactly the fictional ones** |

The set of contracts drawn wrongly is EXACTLY the set whose clients are created inside a library.

Note the server side already complies and needs no change: `server-auth` and `company-svc-core` — the
two most reused server libraries — never create a client. `LoginService` injects `AuthStoreApi`;
`WarmupController` injects its downstream. The app server's own module supplies the client with a
literal. So this rule mostly CODIFIES the pattern the framework already pushes people toward, and the
angular libraries are the outlier.

**The two halves compose.** A `role:lib` may still legitimately hold the api TYPE and the DI token; it
simply must not construct the transport. And a client project should still declare `callsService`,
because even in an app the config is often a variable (`createRpcClient(ExampleApi, config)` in
`app.config.ts` today). Rule + declaration together mean every `uses` edge resolves to one service with
no literal required at all.

Worth flagging honestly: adopting this is not free for the consuming repo. `core-angular`'s
`provideCoreClient` and `auth-angular`'s `provideSharedAuth` create their clients precisely so an app
gets working auth/warmup/browser-log wiring in one call, and moving construction to each app trades a
little duplication for the guarantee. That is a fair trade for a graph that cannot lie, but it should
be a deliberate decision with a migration path (e.g. the lib exposes a factory the app invokes), not a
rule that lands and breaks every angular repo on upgrade. Suggest shipping it WARN-first, then
promoting to error.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts` — where the `ClientConfig` literal is captured onto the `uses` relation (#475)
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts` — `buildEdges`, target resolution + the fan-out fallback and its warning
- wherever `metadata.webpieces.serviceName` is read from `project.json` — `callsService` belongs beside it

## Acceptance check

1. A client project declaring `callsService` produces exactly ONE edge per used api, to that service,
   with no warning.
2. A literal `ClientConfig` at a call site still wins over the project-level declaration.
3. A client with neither still fans out AND still warns (no silent regression).
4. Declaring `callsService` pointing at a service that does not implement the api is an ERROR, not a
   silent drop — the same contract #476 established for named services.

For the companion rule:

5. A `role:lib` calling `createRpcClient` / `createPubSubClient` is reported (WARN first, then error).
6. A `role:server` or `role:client` calling them is untouched.
7. A lib that merely IMPORTS the api type or its DI token — the `server-auth` / `company-svc-core`
   pattern — is untouched. Only constructing the transport is the violation.
8. With the rule satisfied repo-wide, the runtime graph contains ZERO fan-out warnings, because every
   creation site sits in a project with a declared identity or target.

---

### Consuming-repo status (context)

`acme-edu/consumer-repo3` is on 0.4.464 with all four servers declaring `serviceName`. Server→server
edges are now exactly right (`helper-svr -> helper-fsdb-svr` only). The four browser→server edges above
are the only remaining fiction in the graph, and the repo has no way to remove them.
