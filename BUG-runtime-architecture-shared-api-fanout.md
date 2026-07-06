# BUG: runtime-architecture fabricates edges when an API contract is implemented by MULTIPLE services

**Package:** `@webpieces/nx-webpieces-rules` 0.3.239 (executor `generate` — the runtime graph built
from `service-contract.json` files — and everything downstream: `visualize-runtime`,
`validate-runtime-architecture`).

**Repro project:** `/Users/deanhiller/workspace/ctoteachings/monorepo1`
**Evidence file:** `/Users/deanhiller/workspace/ctoteachings/monorepo1/architecture/runtime-dependencies.json`

## The wrong output

`runtimeEdges` contains two edges that DO NOT EXIST at runtime:

```json
{ "from": "helper-portal-angular", "to": "lang-server",       "via": ["auth-apis"] },
{ "from": "lang-angular",          "to": "helper-portal-svr", "via": ["auth-apis"] }
```

`helper-portal-angular` does not even depend on lang-apis, and it NEVER calls lang-server —
each website only calls ITS OWN backend. Yet the runtime diagram draws both websites depending
on both servers.

## Root cause

`@myorg/auth-apis` is a SHARED contract (the whole point of a reusable login library): BOTH
servers implement it, and BOTH websites use it — each against its own server:

```
helper-portal-angular  uses  [portal-apis, auth-apis]
lang-angular           uses  [lang-apis,   auth-apis]
helper-portal-svr  implements [portal-apis, auth-apis, agent-apis]
lang-server        implements [lang-apis,   auth-apis, agent-apis]
```

The generator resolves `uses: X` by adding an edge to EVERY service in `implementedBy[X]` —
a cartesian fan-out. That heuristic is only valid while every api has exactly ONE implementer.
The moment a contract is shared (auth-apis here; any future shared health/billing/admin api),
the graph silently invents calls that never happen. Note the fan-out IS correct for
`agent-listener` (it genuinely calls both servers via agent-apis) — so the information "which
implementer(s) does this consumer actually call" simply does not exist in today's contract
format; the generator guesses, and guesses wrong.

## Suggested fix

Let `service-contract.json` `uses` entries optionally PIN the target service(s), e.g.:

```json
{ "uses": [ "@myorg/apis", { "api": "@myorg/auth-apis", "servedBy": ["helper-portal-svr"] } ] }
```

- Unpinned + single implementer → current behavior (edge to the one implementer).
- Unpinned + MULTIPLE implementers → either an ERROR ("ambiguous: pin servedBy") or an
  explicitly-marked ambiguous edge — anything but silently drawing all of them.
- Pinned → edge(s) only to the named services (agent-listener would pin BOTH servers, the
  websites pin their own).

This also improves `validate-runtime-architecture`: today it blesses the fabricated edges, so
it can never catch a REAL accidental cross-app call — the diagram already shows everything
connected to everything.
