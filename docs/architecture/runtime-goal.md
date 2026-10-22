# Runtime architecture goals: propose, view, compare (#1239)

A **runtime goal** is a proposed runtime architecture, written before the code that implements it.
It lives in its own checked-in file, so a proposal is reviewed in Git like any other change and
survives every `architecture:generate`.

This covers the RUNTIME graph only. The build dependency graph and the per-project DI graphs have no
goal file and no goal comparison.

| File / target | What it is |
|---|---|
| `architecture/runtime-dependencies.json` | the saved CURRENT runtime graph, generated from source |
| `architecture/runtime-dependencies-goal.json` | the editable GOAL, owned by your repository |
| `architecture:visualize-runtime` | draws current → `tmp/webpieces/runtime-architecture.{dot,html}` |
| Color by → **Goal vs Current** | on that page: compares the two saved files, Current → Goal |

The target is inferred by `@webpieces/nx-webpieces-rules`; nothing is hand-wired. There is one runtime
page: the goal is never drawn on a page of its own, only as the Goal vs Current overlay (#1373).

## Start a proposal

Copy the current graph explicitly — viewing never creates or replaces the goal:

```sh
cp architecture/runtime-dependencies.json architecture/runtime-dependencies-goal.json
```

Then edit the copy and commit it. The goal uses the same `RuntimeGraph` shape as the current file:
`services`, `apis`, `runtimeEdges`, `queues` (method queues), `contractQueues`, `externalSystems`,
`remoteServices`, `triggers`, `unresolvedUses`, levels and `maxLevel`. A proposed service does not
have to exist in source: add it under `services` (with `implements`, `uses`, `dependsOn` arrays, `[]`
when empty) and draw its relationships in `runtimeEdges`. Saved project metadata, when present, only
enriches matching boxes; it never rejects or overwrites a proposed one.

## Keep derived facts consistent: `--prepare-goal`

Levels, self-queue flags, `contractQueues` and `maxLevel` are DERIVED from relationships. After
editing relationships, recompute them with the generator's own level machinery (`RuntimeNodeLevels`)
in one explicit, writing step:

```sh
pnpm nx run architecture:visualize-runtime --prepare-goal
```

It prints every field it changed and then views the page with the prepared goal. Plain viewing is
read-only: when the saved derived facts disagree with the relationships it warns, names each
difference, and compares the goal as saved. A method queue's `producedBy` / `consumedBy` lists are yours to keep in step with the
pubsub edges that name that queue; contract-level pubsub edges need no queue entry beyond what
`--prepare-goal` writes.

The goal is validated against itself, never against source. A broken reference (an edge to a service
the goal does not declare, a queue edge naming a missing queue) fails with the goal path, the element
and the edit that fixes it. A cycle in the goal is reported by `--prepare-goal` with the shared cycle
verdict; the CURRENT generation and its unchanged-check are untouched by anything in the goal file.

## Goal vs Current

The runtime page carries the comparison, computed from the two SAVED files — never from Git status,
changed source files, timestamps or the Impact sidecar. A clean tree with both files committed still
shows every difference. The existing Impact mode keeps its meaning (what changed in Git).

The overlay draws the goal plus everything only the current graph has, through the same renderer:

| Status | Box | Arrow |
|---|---|---|
| added in goal | green | green |
| removed from goal | red, dashed — still drawn | red, dotted |
| changed | amber; a moved level reads `L4 → L2` | amber |
| unchanged | grey context | grey |

Click a box (node menu → **Goal vs Current details**) or an arrow for before/after lines. A service
whose outgoing calls changed is itself changed, and its details list the calls before and after.
Filter, Lock, hover chains and the product filter work on the overlay; switching to another mode
restores that page's own graph.

Missing inputs are explicit, never "no differences": with no goal, the Goal vs Current item is
dimmed, cannot be selected, and its subtitle reads "runtime-dependencies-goal.json does not exist"
(the tooltip says how to start one); an unusable goal dims it the same way with the goal path and the
broken element. Identical files say "No differences" over the normal graph.

### Comparison policy

- Identities are underlying keys — a service's project key, a queue's `Api.method`, a contract
  queue's API, an external system's identity — never display names or renderer edge ids.
- Set-like arrays are compared as sets and objects by key, so reordering is never a change, and
  duplicate relationship facts fold together.
- Queue facts are compared per method / per contract BEFORE presentation grouping; each pubsub edge is
  an enqueue plus a delivery relationship. A queue box never merges members of different status.
- Ignored as bookkeeping: `levelBecause`, `wiringUses` / `wiringImplements`, and `dependsOn` (the build
  graph). `maxLevel` appears in the summary.
- The overlay is presentation only: it keeps each element's own saved level (goal level for retained
  and added, current level for removed), is never levelled or cycle-checked, so a cycle that exists
  only in the overlay of two architectures is never reported as an architectural cycle.
