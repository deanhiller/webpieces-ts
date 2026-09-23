# API documents: generated into the build, never committed

Read this when you change a contract (`*Api.ts`, an `@ApiType`, a `{ hidden: true }`), an
`openapi.manifest.json`, anything under `packages/docs/**`, or an `openapi-generate` / `docs-generate`
target. Decided on issue #986 (phase 6 of #980); the comments there are the record of why.

## The rule

**An app's generated OpenAPI documents, `mcp-tools.json` and docs site are BUILD OUTPUT. They are
written into the nx project's own build `outputPath` and are never committed.** `dist/` is gitignored,
and `dist/` is what is packed and published — so the documents ship INSIDE the api library's npm
package, and a consumer installs the library and has the contract. Writing them anywhere else means the
document is generated and then not delivered.

| repo | commits a generated document? |
|---|---|
| a CONSUMING repo (monorepo-nx1, any upstream project) | **never** — it trusts the generator |
| webpieces-ts | only as TEST GOLDENS under `src/__tests__/goldens/` — a spec's expected output, proving the generator did not break |

`apps/app-example/partner-api/src/__tests__/goldens/` and
`packages/docs/api-doc-model/src/__tests__/goldens/` are the second kind. A document under a
`generated/` directory in the tree is the first kind wearing the second's clothes.

## Where the output goes: ASK nx, never assume `dist/`

The executors read the project's declared `build` target `options.outputPath`. That is the one source
of truth, it already exists per project, and it is why there is **no `webpieces.config.json` key** for
the path — a second place to state it is a second place to disagree. The two measured layouts differ:

| repo | build outputPath |
|---|---|
| webpieces-ts | `dist/apps/app-example/partner-api` (workspace-ROOT dist) |
| onetablet/monorepo-nx1 | `libraries/apis/partner-apis/management-api/dist` (project-LOCAL dist) |

Anything that hardcodes `./dist` or `<projectRoot>/dist` is right in one and wrong in the other.
`wp-openapi --out` stays for use outside an nx workspace; inside one, nobody chooses a path. The
manifest stays beside the SOURCE — it is hand-authored input and carries no output path.

## The two executors

```json
"openapi-generate": {
  "executor": "@webpieces/nx-webpieces-rules:openapi-generate",
  "dependsOn": ["build"],
  "cache": true,
  "inputs": ["default", "^default"],
  "outputs": [
    "{workspaceRoot}/<build outputPath>/*openapi.json",
    "{workspaceRoot}/<build outputPath>/*openapi.yaml",
    "{workspaceRoot}/<build outputPath>/mcp-tools.json"
  ],
  "options": { "manifest": "<project>/openapi.manifest.json", "format": "both" }
},
"docs-generate": {
  "executor": "@webpieces/nx-webpieces-rules:docs-generate",
  "dependsOn": ["openapi-generate"],
  "cache": true,
  "inputs": ["default", "^default"],
  "outputs": ["{workspaceRoot}/<build outputPath>/docs-site"],
  "options": { "document": "public-openapi.json", "siteDir": "docs-site", "prose": "<project>/docs" }
}
```

Every option but `prose` is required and has no default. Two parts of that wiring are CHECKED at run
time rather than merely recommended, because both failures are silent:

- **`dependsOn: ["build"]`.** The executor writes into the directory tsc cleans. Without the edge, nx
  may run the two together, the clean deletes the document, and a dependent test dies on ENOENT —
  intermittently, and mostly in CI. `openapi-generate` refuses to run without it (`docs-generate`
  likewise refuses without `dependsOn: ["openapi-generate"]`).
- **`outputs`.** Every file a run writes must be covered by a declared output, or a cache hit restores
  a package without it. The executor generates into a staging directory, so it knows exactly what it
  wrote, and refuses when a file is uncovered.

`docs-generate` renders the PARTNER-facing document: a site built from `full-private-openapi.json`
publishes exactly the operations somebody decided not to publish.

## The generator is the consumer's, never a bundled copy

The executors run `@webpieces/openapi-generator` / `@webpieces/docs-site` from the CONSUMER's
`node_modules`, found by walking up from the project the way node does — never a copy inside the nx
plugin. The generator must be the release the consumer pinned beside the decorators it reads; a bundled
copy would be the rules stream's release, which a repo deliberately runs one release behind.

A version handshake guards the lockstep case: an installed generator older than the capabilities the
executor needs is refused with `@webpieces/openapi-generator >= X.Y.Z` as the cure. A capability always
ships in the generator first; the tooling that relies on it follows and raises the minimum in the same
change (`GeneratorPackage` in `@webpieces/pr-gate`). A workspace link (`0.0.0-dev`, no compiled bin) is
not a release and is refused the same way.

## What replaced the committed document: the contract diff on the PR

A committed document was attractive for one reason: a newly partner-visible endpoint showed up as a
reviewable diff — the backstop for `hidden`, because an annotation records what somebody TYPED and the
document shows what will actually SHIP. That now happens in the PR gate: `wp-finish-upsert-pr`
generates `public-openapi.json` at the merge-base and at HEAD for every project declaring an
`openapi-generate` target, diffs them structurally (operations, webhooks, schemas field by field,
top-level sections), and posts the result as a PR comment. It is strictly better than a committed file —
nothing generated in the repository, the diff is against what actually shipped, it appears where
reviewers already look, and it cannot be skipped by forgetting to run a command.

A declared contract that does not generate at HEAD stops the stage before anything is pushed. A
merge-base that today's generator refuses is reported in the comment, not treated as this PR's defect.

There is deliberately **no `validate-openapi-unchanged`**. It existed only to police a committed
artifact; a document regenerated on every build cannot be stale.

## webpieces-ts itself

This repo does not wire `partner-api` to the executors yet: it runs the previous published plugin, and
its example app links the generator as `workspace:*` source, which the handshake refuses by design.
That wiring is [#1019](https://github.com/deanhiller/webpieces-ts/issues/1019). The executors are
proven by `generated-docs-executors.spec.ts` (nx-webpieces-rules) and the generator by
`openapi-golden.spec.ts` (partner-api) in the meantime.
