# BUG: runtime graph fans every edge out to EVERY implementer, ignoring the ClientConfig service name (0.4.459)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.459`
**Severity:** High — **silently wrong output**. `architecture:generate` exits 0 and writes a
`runtime-dependencies.json` containing calls that **cannot happen**, and `validate-runtime-architecture`
then fails on **cycles that do not exist**. A wrong-but-green runtime graph is worse than a failing one:
it is committed, rendered, and used to reason about blast radius.

## Symptom

In the consuming repo the rendered runtime graph shows:

```
helper-portal-angular  ->  lang-fsdb-svr     [label: "BrowserLogApi, WarmupApi"]
```

The helper portal's browser bundle has no route to the **lang** product's data server — different
product, different GCP project, and the fsdb surface is `@AuthOidc()` service-to-service only. The
edge is fiction. The same fan-out produces `helper-portal-angular -> helper-fsdb-svr`.

It also manufactures **false cycles**. Binding a `WarmupApi` client on an app server so it can warm its
data server produced:

```
❌ runtime cycle: helper-svr -> lang-server -> helper-svr
```

helper-svr has never called lang-server. The cycle is an artifact of the fan-out, and it blocks the
build via `validate-runtime-architecture`.

## Root cause: buildEdges cross-products users x implementers

`packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:221-240` (`buildEdges`) emits an edge for
every (user, implementer) PAIR of an api:

```ts
for (const [api, info] of apis) {
    for (const user of info.usedBy) {
        for (const impl of info.implementedBy) {   // <-- every implementer, unconditionally
            if (user === impl) continue;
            addEdge(user, impl, api, info.type);
        }
    }
}
```

For a **company-wide** api this is catastrophic. `WarmupApi` and `BrowserLogApi` are registered ONCE, in
a shared library (`company-svc-core/CompanyRouteModule.ts`), and the transitive walk in
`collectEffectiveRelations` (`runtime-graph.ts:151-196`) correctly attributes them to **all four**
servers. Any browser that uses `WarmupApi` therefore gets an edge to every server in the repo.

The fan-out is worst exactly where the api is most shared — i.e. the framework's own cross-cutting
contracts are the ones that corrupt the graph.

### The disambiguator already exists in the source and is discarded

Every call site names its target:

```ts
factory.createRpcClient(AuthStoreApi, new ClientConfig('helper-fsdb'))
factory.createRpcClient(WarmupApi,    new ClientConfig('helper-fsdb'))
```

`api-scanner.ts:303-306` resolves argument 1 (the api class) and **ignores argument 2**. The scanner
already has the exact information needed to make the edge single-target, and throws it away.

## Suggested fix

1. **Capture the target at the call site.** In `api-scanner.ts:303-306`, when the `createRpcClient`
   second argument is `new ClientConfig('<literal>')`, record that literal on the `uses` relation
   (e.g. `ApiRef.targetService`). A non-literal expression records nothing and falls through to (3).

2. **Target the edge in `buildEdges`.** When a `uses` relation carries a target service, emit ONE edge
   to the node whose declared service name matches, instead of iterating `implementedBy`.

3. **Resolve name -> project explicitly; do NOT derive it.** The three naming spaces in the consuming
   repo have no mechanical relationship:

   | nx project | ClientConfig name | Cloud Run PROD | Cloud Run DEMO |
   |---|---|---|---|
   | `helper-svr` | `helper-portal` | helper-portal | helper-portal-demo |
   | `helper-fsdb-svr` | `helper-fsdb` | helper-fsdb | helper-fsdb-demo |
   | `lang-server` | `lang` | lang | lang-demo |
   | `lang-fsdb-svr` | `lang-fsdb` | lang-fsdb | lang-fsdb-demo |

   Stripping `-svr` works for the fsdb pair and fails for `helper-svr -> helper-portal`. Suggest reading
   a declared name from `project.json`, which the generator already loads:

   ```json
   "metadata": { "webpieces": { "serviceName": "helper-fsdb" } }
   ```

   (The consuming repo has already added this to all four servers, so the data is there to test against.)

4. **Degrade LOUDLY, never silently.** If a `uses` has a target the graph cannot resolve to a node, keep
   today's fan-out but PRINT a warning naming the api, the caller and the unresolved service name.
   Silent fan-out is what makes this bug survive.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts:303-306` — records `uses`, drops arg 2
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-relations.ts:57-61` — relation shape (`kind`), where a `targetService` would live
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:221-240` — `buildEdges`, the cross product
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:151-196` — `collectEffectiveRelations` (correct as-is; it is what makes shared-lib apis land on every server)

## Acceptance check

In a repo where a browser client uses a company-wide api implemented by every server:

1. `helper-portal-angular` has runtime edges to `helper-svr` ONLY — no edge to `lang-fsdb-svr`,
   `helper-fsdb-svr`, or `lang-server`.
2. An app server binding a `WarmupApi` client aimed at `ClientConfig('helper-fsdb')` produces exactly
   one edge, `helper-svr -> helper-fsdb-svr`, and NO `helper-svr <-> lang-server` cycle.
3. A `createRpcClient` whose config is a variable rather than a literal still produces a graph, plus a
   printed warning naming the unresolved call site.

---

### Consuming-repo status (context)

`ctoteachings/monorepo3` currently works AROUND this. An app server cannot bind a `WarmupApi` client to
warm its data server, because doing so trips the false cycle and fails the build. Instead each fsdb
contract declares its own `ping` endpoint and the app server forwards over the fsdb client it already
holds — chosen because that contract has exactly one implementer, so the resulting edge is true. That
is a design decision made to satisfy the tooling, not the domain.
