# BUG: the runtime graph silently DELETES any `role:server` that has no api relations (0.4.523)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.523`
**Severity:** High — a deployed, running microservice is absent from the microservice diagram with
no warning, no problem, and no log line. The diagram looks complete, so nobody goes looking. This
is the failure mode where the tool is *confidently* wrong rather than visibly incomplete.

## Symptom

A repo with 12 `role:server` projects rendered a runtime graph containing 4 of them. The 8 missing
ones produced **zero** diagnostic output — `architecture:generate` reported success, and
`architecture:validate-runtime-architecture` passed clean.

One of the missing services (`crm-manager`) is a genuine webpieces server: it boots `CompanyServer`,
has inversify DI and an `AppModules` with `getRoutingModules()`, and does real work off a PubSub
pull subscription. Its only unusual property is that it declares **no routes** and therefore no
`apiRelations` — the subscription is published by an external system, so there is no in-repo
contract to hang a relation on.

The user's reasonable conclusion was "the tooling is broken / my nx tags are wrong." Neither was
true. The node was deliberately, silently dropped.

## Root cause

`packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:309`, in `collectDecls()`:

```ts
private collectDecls(): ScanDecl[] {
    const decls: ScanDecl[] = [];
    for (const name of Object.keys(this.projects).sort()) {
        if (!this.isNode(name)) continue;              // <- correctly selects role:server / role:client
        const sink = new RelationSink(name);
        this.collectEffectiveRelations(name, sink, new Set<string>([name]));
        if (sink.implementsApis.length > 0 || sink.usesApis.length > 0) {   // <- and then throws it away
            decls.push({ ... });
        }
    }
    return decls;
}
```

`isNode()` has already established this project IS a runtime node. The very next statement discards
it unless it happens to carry an api relation. Everything downstream — `buildApis`, `buildEdges`,
`buildServices`, `buildTriggers` — is driven off `decls`, so the node does not merely lose its edges:
**it does not exist** in `runtime-dependencies.json` at all.

### This contradicts the documented `drawOnGraph` contract

`draw-on-graph-resolver.ts` states the repo's own promise:

> Every project is drawn by default; a project opts OUT by carrying the nx tag `drawOnGraph:false`.

There is no way to opt back IN, because a server with no relations was never opted out on paper —
it is removed by an undocumented filter that `drawOnGraph` knows nothing about.

### Connectivity is demonstrably not the reason

In the same graph, `team-dashboards` renders as a lone box touching nothing:

```json
"team-dashboards": { "level": 0, "implements": ["TeamDashboardsApi"], "uses": [], "dependsOn": [] }
"TeamDashboardsApi": { "implementedBy": ["team-dashboards"], "usedBy": [], "type": "rpc" }
```

Nothing in-repo calls it (its only consumer is a browser page the service serves itself), so it
produces zero edges — and it is drawn anyway. So the visualizer handles isolated, edgeless nodes
perfectly well.

The dividing line between "drawn" and "does not exist" is therefore **not** connectivity, **not**
`role:`, and **not** `drawOnGraph`. It is whether the service happened to declare an abstract `*Api`
class — even one no caller ever touches. A service that declared a contract nobody uses is drawn;
a service doing real work with no contract is deleted.

### It is still live in 0.4.523

The external-systems feature added in 0.4.523 masks this by accident: declaring
`external:<kind>:<identity>` or depending on a vendor contract gives a service a relation, so it
reappears. In the repo above, `crm-manager` came back only because `externalApiPaths` gave it an
`AttioApi` edge — not because the filter was fixed. A server with no contracts and no external
declarations still vanishes.

## Suggested fix

1. **Emit a decl for every node.** Drop the `length > 0` condition entirely — `isNode()` is the
   correct and sufficient test:

   ```ts
   if (!this.isNode(name)) continue;
   const sink = new RelationSink(name);
   this.collectEffectiveRelations(name, sink, new Set<string>([name]));
   decls.push({
       name,
       implementsApis: dedupApiRefs(sortApiRefs(sink.implementsApis)),
       usesApis: dedupApiRefs(sortApiRefs(sink.usesApis)),
       implementsVia: sink.implementsVia,
   });
   ```

   An isolated node then renders exactly as `team-dashboards` already does. "This service talks to
   nothing we can see" is a legitimate and useful thing for an architecture diagram to say — it is
   often the finding.

2. **If any filtering is kept, make it loud.** Push a warning naming each dropped node and why, so
   the absence is visible rather than inferred.

3. **Honour `drawOnGraph` as the single opt-out.** A repo that genuinely does not want a bare
   server drawn already has `drawOnGraph:false` for exactly that.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:302-318` — `collectDecls`; the filter is at :309
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts` — `isNode()`, the correct node test, already applied one line earlier
- `packages/tooling/nx-webpieces-rules/src/lib/draw-on-graph-resolver.ts` — the drawn-by-default contract this violates
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` — already renders edgeless nodes correctly

## Acceptance check

1. A `role:server` with no `apiRelations` and no external declarations appears as a node in
   `runtime-dependencies.json` and in the rendered graph.
2. That node renders as an isolated box, the way an implements-only service already does.
3. `drawOnGraph:false` is the ONLY thing that removes a server from the drawing.
4. If a node is dropped for any other reason, generate prints a warning naming it.
