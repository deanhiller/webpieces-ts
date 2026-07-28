# BUG: "who implements this api" is computed correctly and then never rendered in either graph (0.4.459)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.459`
**Severity:** Medium — not wrong, but the single most important relationship in a microservice
architecture is invisible in both diagrams. Users conclude the data is missing and start "fixing"
correct api designs to make the picture look right.

## Symptom

Open `architecture/dependencies.html` and look at `auth-store-api` and `auth-apis`: solid dependency
arrows only. **Nothing** shows which server implements either contract — no dotted edges, no
annotation. The natural conclusion is that the tool failed to detect it.

Open the runtime graph (`architecture:visualize-runtime`) and every node reads:

```
helper-svr
(server, L1)
```

The api list is nowhere on the node. You can only infer implementations from INCOMING edge labels —
so an api that a server implements but nothing in-repo calls is completely invisible, and an api
implemented by many servers is indistinguishable from one implemented by the right one.

## Root cause: the data is computed, used for one boolean, and dropped

`packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` (`runtime-visualizer.js:57` in the
published build):

```js
const role = svc.implements.length > 0 ? 'server' : 'client';
dot += `  "${getShortName(name)}" [fillcolor="${color}", label="${getShortName(name)}\\n(${role}, L${svc.level})"];\n`;
```

`svc.implements` — the full, correct list — is reduced to a single server/client boolean and then
discarded. `runtime-dependencies.json` on disk has it all along:

```json
"helper-fsdb-svr": { "level": 0, "implements": ["AgentThreadsPort","AuthStoreApi","BrowserLogApi","HelperFsdbApi","WarmupApi"], "uses": [] }
```

The build graph has the same information in `dependencies.json` under `apiRelations`, and the HTML
visualizer never draws it.

## Suggested fix

1. **Runtime graph — put implemented apis on the node.** Either in the label or a side panel:

   ```
   helper-svr (server, L1)
   implements: AgentApi, AuthApi, EmailSourcesApi, WarmupApi ...
   uses: HelperFsdbApi, AuthStoreApi
   ```

2. **Build graph — draw `apiRelations` as dotted edges.** A dotted `implements` edge from each
   server to the api-lib it serves, distinct from the solid dependency arrow, so `auth-store-api`
   visibly resolves to `helper-fsdb-svr` / `lang-fsdb-svr`.

3. **Say WHERE the implementation came from.** When a server implements an api via an embedded
   library, record and show the owning library:

   ```
   WarmupApi   implemented by helper-svr, lang-server, helper-fsdb-svr, lang-fsdb-svr
               (via library company-svc-core)
   ```

   Today answering "who implements `WarmupApi`?" requires knowing that `collectEffectiveRelations`
   walks the `dependsOn` closure and then walking it by hand. The per-project `apiRelations` in
   `dependencies.json` show the relation on `company-svc-core`, NOT on any server, so a per-project
   reading looks like a detection failure. It is not — but nothing says so.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts:47-67` — node emit; `implements` collapsed to a boolean at :57
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:199-218` — `buildApis`, where `implementedBy` is assembled
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:151-196` — `collectEffectiveRelations`, the lib -> server attribution worth surfacing
- the build-graph HTML/DOT visualizer — draws `dependsOn` only, never `apiRelations`

## Acceptance check

1. A server node in the runtime graph names the apis it implements, without relying on any incoming edge.
2. An api implemented by a server that NOTHING in-repo calls still appears on that server's node.
3. The build graph shows a visually distinct implements relation from a server to an api-lib.
4. For an api implemented via a shared library, the output names that library.
