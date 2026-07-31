# BUG: nothing validates `external:*` tags or that every server reached the graph (0.4.523)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.523`
**Severity:** Medium-High — the architecture graph is presented as derived truth, but two of its
claims are hand-typed strings no rule ever checks. A wrong one is indistinguishable from a right
one, and the diagram's authority is exactly what stops anyone verifying it by hand.

## Symptom

`validate-runtime-architecture` runs exactly two checks (`executors/validate-runtime-architecture/executor.ts`):

1. **no disallowed cycles**
2. **graph unchanged since commit** — i.e. "did you re-run `architecture:generate`"

Check 2 is a *freshness* check, not a *correctness* check. It proves the JSON matches what the
scanner currently produces. It cannot tell you the scanner was fed a lie.

Two categories of lie are currently unverifiable:

### A. An `external:<kind>:<identity>` tag that does not match reality

The 0.4.523 tag is a free-form assertion on `project.json`. Nothing correlates it with the code.

This is not hypothetical. Adopting the feature, an engineer tagged a service
`external:database:postgres` after seeing `typeorm` in its `package.json`. The service opens no
database at all — it has zero `new DataSource` / `new Pool` calls, imports `typeorm` nowhere in
`src`, and reaches the database exclusively through an RPC call to a dedicated data-access service.
The dependency was inert.

The generated diagram then asserted a direct service→postgres arrow that does not exist, in a repo
whose whole architecture is "one service owns the DB connection." **CI was green.** It was caught
only because a human looked at the picture and said "that feels wrong." The inverse — a service that
genuinely opens a connection and was never tagged — is equally invisible, and strictly harder to
notice, because nothing appears where something should.

### B. A `role:server` that never made it onto the graph

Nothing asserts that every runtime node is present in `runtime-dependencies.json`. Combined with the
silent-drop filter (see
`bug-runtime-graph-silently-deletes-any-server-with-no-api-relations.md`), a repo can have 12 servers
and a 4-node graph while every check passes.

## Suggested fix

Add checks to `validate-runtime-architecture` — it already loads both `dependencies.json` and the
project infos, so neither needs new plumbing.

### 1. Every server is on the graph

```
FAIL: role:server 'crm-manager' has no node in the runtime graph.
      Tag it drawOnGraph:false if that is intended.
```

Cheap, exact, no source scanning. It makes the silent-drop bug impossible to ship unnoticed and
turns `drawOnGraph:false` into the honest declaration it was documented to be.

### 2. Cross-check `external:*` tags against client construction

The scanner already walks every source file for `createRpcClient` / `addRoutes`. Extend that pass
with a small, configurable marker table — the same shape as
`FRAMEWORK_DEPENDENCY_MARKERS` in `framework-resolver.ts`, which already does dependency→meaning
mapping:

```ts
new ExternalMarker('database', 'postgres', ['new Pool(', 'new DataSource(']),
new ExternalMarker('database', 'bigquery', ['new BigQuery(']),
new ExternalMarker('storage',  'gcs',      ['new Storage(']),
```

Then report both directions:

```
FAIL: pg-dataaccess is tagged external:database:postgres but constructs no postgres client
      (looked for: new Pool(, new DataSource(). Remove the tag or declare the marker.)

WARN: reports-dispatcher constructs `new Pool(` but carries no external:database:* tag
      — the graph will not show its database dependency.
```

Direction 1 should FAIL (an asserted edge that does not exist is a lie in the diagram).
Direction 2 should WARN by default, since the marker table can never be exhaustive — a repo opts
into failing once its markers cover its stack.

**Importantly, this is opt-in and empty by default.** No marker table configured = no checks = no
false failures for repos using clients this table has never heard of. A repo that adds three lines
gets the guarantee for its three datastores.

### 3. Failing that, at minimum say the tags are unverified

If cross-checking is judged out of scope, `architecture:generate` should print the declared external
systems and their sources, so they are at least *reviewable*:

```
📡 External systems declared (NOT verified against source):
   postgres (database) <- nx tag on: pg-dataaccess, crm-manager, reports-dispatcher
   bigquery (database) <- nx tag on: ai-chat, team-dashboards
```

A list a reviewer can scan beats a diagram that silently encodes an unchecked claim.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/executors/validate-runtime-architecture/executor.ts` — the two existing checks; where these belong
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/external-systems.ts` — `parseExternalTag`, which accepts any well-formed tag without correlating it to code
- `packages/tooling/nx-webpieces-rules/src/lib/framework-resolver.ts` — `FRAMEWORK_DEPENDENCY_MARKERS`, the existing precedent for a marker table
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/api-scanner.ts` — the source pass a marker check would ride along with

## Acceptance check

1. A `role:server` absent from the runtime graph fails validation unless it is `drawOnGraph:false`.
2. A service tagged `external:database:postgres` that constructs no postgres client fails, naming
   the markers it looked for.
3. A service constructing a marked client with no matching tag warns.
4. With no marker table configured, neither external check runs and nothing regresses.
5. `architecture:generate` lists declared external systems and where each declaration came from.
