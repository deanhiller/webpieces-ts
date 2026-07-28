# FEATURE: show external api libs (firestore, gmail, ...) as terminal nodes in the runtime graph

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.459`
**Severity:** Medium — the runtime graph stops one hop short of the truth. The whole point of the
diagram is seeing every moving part at runtime, and the parts most likely to fail (the vendor systems)
are the ones missing.

## Symptom

The runtime graph ends at the data servers:

```
helper-portal-angular  ->  helper-svr  ->  helper-fsdb-svr
```

But `helper-fsdb-svr` then talks to **Firestore**, and `helper-svr` talks to the **Gmail API** — the
external systems that actually page you at 3am. Neither appears. Reading the diagram, the data servers
look like leaves that store data by magic.

In the consuming repo these are real, first-class, mockable contracts under `libraries/apis/external/`
(`lib-firestore`, `lib-gmail`, `lib-gcp-tts`, `lib-gcp-storage`) — the same seam its tests rebind. They
are architecturally identical to the internal apis already drawn, and the true runtime path is:

```
helper-portal-angular -> helper-svr -> helper-fsdb-svr -> lib-firestore
```

## Root cause: only server/client PROJECTS are eligible to be nodes

`packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:170-173`:

```ts
private isNode(project: string): boolean {
    const role = ...;
    return role === 'server' || role === 'client';
}
```

An external api lib is a LIBRARY, so it can never be a node, and any relation to it is invisible. This
is also load-bearing for the transitive walk (`collectEffectiveRelations` stops at nodes), so the fix
must not simply promote libs to nodes — see below.

## Suggested fix

1. Emit a **terminal node** for an api that is `usedBy` some node and implemented by NOBODY in-repo —
   which is exactly the `unresolvedUses` set already computed at `runtime-graph.ts:226-229` and today
   only printed as a warning by `validate-runtime-architecture` (`executor.ts:109-111`). That data is
   sitting there; it just is not drawn.

2. Render them distinctly — different shape/colour, e.g. a dashed box labelled `lib-firestore
   (external)` — so "we call out to a vendor here" is visually obvious and never confused with a
   service the repo owns.

3. **Do not make them graph nodes for traversal purposes.** They must not participate in
   `assignLevels` cycle detection or in `collectEffectiveRelations`' stop-at-node rule, or the
   transitive attribution that makes shared-library implementations work would break. Render-only.

4. Optionally let `webpieces.config.json` opt out, for a repo whose external surface is noisy.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:170-173` — `isNode`, the eligibility gate
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:226-229` — `unresolvedUses`, already exactly the set to draw
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts:94-106` — `assignLevels`, which terminal nodes must stay out of
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts:47-67` — node rendering
- `packages/tooling/nx-webpieces-rules/src/executors/validate-runtime-architecture/executor.ts:109-111` — where the same data is currently only warned about

## Acceptance check

1. A repo whose data server calls an external contract implemented by no in-repo service renders that
   contract as a visually distinct terminal node, with an edge from the calling service.
2. Levels, cycle detection, and shared-library implements attribution are byte-identical to before
   (the addition is render-only).
3. `unresolvedUses` in `runtime-dependencies.json` is unchanged — this consumes it, it does not redefine it.
