# FEATURE: only `role:server` / `role:client` projects may create api clients — a `role:lib` that does FAILS the build

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.468`
**Severity:** Medium-High — this is the difference between a runtime graph that is correct **by
construction** and one that is correct only when every repo remembers to annotate. Without it, the
graph silently reverts to drawing calls that cannot happen.

> Split out of `feature-let-a-client-declare-its-target-service-when-clientconfig-is-not-a-literal.md`,
> whose STATUS says the primary `callsService` fix shipped in #479 and that this companion rule is
> "tracked as follow-up". It was not tracked anywhere — it lived only inside a document now headed
> "primary fix shipped", which is where follow-ups go to die. This file is that tracking.

## The problem it solves

#475 targets a runtime edge from a literal `ClientConfig` at the `createRpcClient` call site. #479 adds
`metadata.webpieces.callsService` for when no literal can sit there. Both are **opt-in**: miss either
and the graph falls back to a fan-out — one edge to EVERY implementer of the api, i.e. calls that
cannot happen, which is what made `helper-portal-angular` appear to call the LANG product's data
server.

The fan-out is worst exactly where a contract is most shared. A company-wide api implemented by every
server (warmup, browser-log, auth) gives every caller an edge to every server. So the better adopted
the framework's own contracts are, the more fictional the picture becomes.

A rule removes the failure mode instead of asking people to remember.

## Proposal

**Only a project tagged `role:server` or `role:client` may call `createRpcClient` /
`createPubSubClient`. A `role:lib` that does is a violation.** A reusable library takes the api
**injected**; the server or app module binds it to a client. Every client-construction site then sits
in a project that has a declared identity (`serviceName`) or a declared target (`callsService`), so
every `uses` edge is attributable and no fan-out fallback is ever reached.

### Evidence this is the right cut

From `ctoteachings/monorepo3`, every client-creation site by project kind, at the time the fiction was
diagnosed:

| Where created | Contracts | Graph result |
|---|---|---|
| SERVER project (`RemoteFsdbModule`), literal `ClientConfig` | HelperFsdbApi, AgentThreadsPort, AuthStoreApi, WarmupApi | correct |
| ANGULAR APP (`app.config.ts`) | ExampleApi, InboxApi, EmailIntakeApi, PortalSettingsApi, EmailSourcesApi, LangSecureApi | correct (single implementer) |
| ANGULAR LIB (`core-angular`, `auth-angular`) | **BrowserLogApi, WarmupApi, AuthApi** | **exactly the fictional ones** |

The set of contracts drawn wrongly was EXACTLY the set whose clients were built inside a library.

The server side already complies and needs no migration: `server-auth` and `company-svc-core` — the two
most-reused server libraries — never create a client. `LoginService` injects `AuthStoreApi`;
`WarmupController` injects its downstream; the app server's own module supplies the client with a
literal. The rule mostly CODIFIES the pattern the framework already pushes people toward. The angular
libraries are the outlier.

## Suggested shape

1. New rule (name suggestion: `no-client-creation-outside-server-or-client`), configured through
   `webpieces.config.json` like every other rule, so a repo adopts it deliberately.
2. **WARN first, then promote to error.** Landing it as a hard failure would break every existing
   Angular repo on upgrade — `provideCoreClient`-style helpers exist precisely so an app gets working
   auth/warmup/log wiring in one call. Give repos a release to migrate.
3. Pair the warning with the migration: name the lib, the api, and the suggested shape (lib exposes a
   factory or takes the api injected; the app/server module constructs the client).
4. A lib that merely IMPORTS the api type or its DI token is FINE and must not be flagged. Only
   constructing the transport is the violation.

## Acceptance check

1. A `role:lib` calling `createRpcClient` or `createPubSubClient` is reported (WARN, then error once promoted).
2. A `role:server` or `role:client` calling them is untouched.
3. A lib importing only the api type / DI token — the `server-auth` and `company-svc-core` pattern — is untouched.
4. With the rule satisfied repo-wide, `architecture:generate` emits **zero** "could not be targeted"
   warnings, because every creation site has a declared identity or target.
5. The rule is off unless configured, so upgrading webpieces cannot break a repo that has not migrated.

---

### Consuming-repo status (context)

`ctoteachings/monorepo3` is on 0.4.468 with `serviceName` on all four servers and `callsService` on
both websites; the graph is correct today. But it is correct because two annotations are present, not
because it cannot be otherwise — delete either and the fiction returns silently. One warning remains
(`agent-listener`, which parses its target from an env var at runtime), and `core-angular` still
creates clients from a `role:lib`, so this repo would have migration work when the rule lands.
