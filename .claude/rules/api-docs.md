# API documents: opted into with a tag, generated into the build, never committed

Read this when you change a contract (`*Api.ts`, an `@ApiType`, a `{ hidden: true }`), an
`openapi.manifest.json`, anything under `packages/docs/**`, an api library's `project.json`, the
`openapi-generate` / `docs-generate` targets, or how an MCP server loads its tool catalogs. Decided on
issue #986 (phase 6 of #980) and corrected by #1021; the issues are the record of why.

## The rule

**An api library's generated OpenAPI documents and MCP tool catalogs are BUILD OUTPUT. They are
written into the outputPath of the library's compile step and are never committed.** `dist/` is
gitignored, and it is what is packed and published — so the documents ship INSIDE the api library's
npm package, and a consumer installs the library and has the contract. Nothing generated is committed,
and nothing generated is compared: there is no PR-gate diff and no `validate-openapi-unchanged`.
Generation is ordinary BUILD work that runs through `nx affected --target=ci` like everything else.

| repo | commits a generated document? |
|---|---|
| a CONSUMING repo (monorepo-nx1, ctoteachings/monorepo, any upstream project) | **never** — it trusts the generator |
| webpieces-ts | only as TEST GOLDENS under `src/__tests__/goldens/` — a spec's expected output, proving the generator did not break |

`apps/app-example/partner-api/src/__tests__/goldens/` and
`packages/docs/api-doc-model/src/__tests__/goldens/` are the second kind.

## Opting in: an nx TAG, the plugin infers the target

Consumers never hand-write an executor target. The `@webpieces/nx-webpieces-rules` plugin infers them
from tags (`generate-targets.ts`):

| tag | inferred |
|---|---|
| `generate:openapi` | `openapi-generate` |
| `generate:docs-site` | `openapi-generate` + `docs-generate` (a site is rendered from a document) |

The plugin owns the executor, `cache`, `inputs` and `outputs`. The consumer states every VALUE in its
project.json under the inferred target name, and nx merges them. Nothing has a default
(`.claude/rules/no-rule-defaults.md`): a missing option is a hard error naming the key. An untagged
project costs one in-memory tag check. A tag the installed plugin does not know is IGNORED, whereas a
project.json naming an executor the installed plugin lacks breaks the graph load — which is why the
opt-in is a tag.

## The api library's shape: `compile` → `openapi-generate` → `build`

nx `dependsOn` only points BACKWARD. Generation must run AFTER tsc (whose cleanup wipes the
outputPath), and every consumer only ever asks for `^build`. So a generating library splits compile
from build:

```json
"tags": ["generate:openapi"],
"targets": {
  "compile": {
    "executor": "@nx/js:tsc",
    "outputs": ["{options.outputPath}"],
    "options": { "outputPath": "dist/libraries/apis/my-apis", "main": "...", "tsConfig": "..." }
  },
  "openapi-generate": {
    "dependsOn": ["compile"],
    "options": { "manifest": "libraries/apis/my-apis/openapi.manifest.json", "format": "both" }
  },
  "build": { "executor": "nx:noop", "dependsOn": ["compile", "openapi-generate"] }
}
```

Every existing `^build` — servers, Dockerfiles like `nx run-many -t build -p lang-server` — then pulls
generation in with zero consumer change. `validate-nx-wiring` enforces the shape on tagged projects
(`openapi-generate` dependsOn exactly one sibling target with an `outputPath`; that target dependsOn
`^build`; `build` is an `nx:noop` over both), and enforces that **every project depending on a
generating library has `test` dependsOn `^build`** — a server spec that boots the MCP server reads the
library's generated catalogs out of its build output.

## Where the output goes: ASK nx, never assume `dist/`

The documents go into the `outputPath` of the ONE target `openapi-generate` dependsOn — never a
hardcoded target name, never an assumed `dist/`. `GeneratedApiDocsLayout` (`@webpieces/core-util`) is
that lookup, and it is the ONE lookup: the executor writes with it, the plugin computes the inferred
`outputs` with it, and `McpToolCatalog.fromPackages` reads a workspace source directory with it. The
measured layouts differ, which is the point:

| repo | compile outputPath |
|---|---|
| webpieces-ts | `dist/apps/app-example/partner-api` (workspace-ROOT dist) |
| onetablet/monorepo-nx1 | `libraries/apis/partner-apis/management-api/dist` (project-LOCAL dist) |

There is no `webpieces.config.json` key for the path — the project already states it, and a second place
to say it is a second place to disagree. `wp-openapi --out` stays for use outside an nx workspace. The
manifest stays beside the SOURCE — it is hand-authored input and carries no output path.

## What a run writes

- The OpenAPI documents, PER LIBRARY: `full-private-openapi.json`, `public-openapi.json`,
  `mcp-openapi.json` (each only when some contract's `@ApiType` asks for it), in `format`.
- The MCP tool catalogs, ONE PER CONTRACT: `mcp-<ContractClass>-tools.json` (e.g.
  `mcp-LangCourseAuthorApi-tools.json`) for each contract that declares `MCP` and has an `@WpMcpTool`.
  One library holds many contracts; a server binds contracts, so each binding is checked against the file
  generated from exactly its own contract.

`outputs` are CHECKED, not trusted: the executor generates into a staging directory, so it knows what it
wrote, and refuses when a written file is not covered — a cache hit would otherwise restore a package
without it.

## The docs site is for HOSTING, not for the package

`docs-generate` (tag `generate:docs-site`) renders the static site into `<projectRoot>/<siteDir>`, e.g.
`generated-docs/`, which the repo gitignores. It is not written into the package: a docs site is
deployed, not installed.

```json
"docs-generate": { "options": { "document": "public-openapi.json", "siteDir": "generated-docs", "prose": "<project>/docs" } }
```

`document` should be the PARTNER-facing document: a site built from `full-private-openapi.json`
publishes exactly the operations somebody decided not to publish. `siteDir` must lie strictly inside the
project, because it is emptied on every run.

## The MCP server loads the catalogs with ONE call

```ts
const catalogs = McpToolCatalog.fromPackages(['@myorg/my-apis'], __dirname);
new McpBindOptions(MCP_PATH, bindings, catalogs, McpDeployment.singleProcess(), []);
```

It resolves `<pkg>/package.json` the way node does, starting from the CALLER's `__dirname` (in a pnpm
workspace the library is linked into the server project's own `node_modules`, which the cwd cannot
see), then:

- the directory holds `mcp-*-tools.json` → a BUILT or published package (Docker relinks
  `node_modules/@myorg/*` onto `dist/libraries/**`; npm consumers get the package) → read them;
- the directory holds a `project.json` → a workspace SOURCE directory (local vitest/dev) → read the
  outputPath of the target its `openapi-generate` dependsOn, against the workspace root found by walking
  up to `nx.json`.

`McpToolRegistry` refuses to boot — naming every directory searched — when a bound contract has no
catalog, a catalog's contract is not bound, or a tool name is declared twice. Hand-built test catalogs
and hardcoded dist paths in a consumer's specs are both rejected designs: the first loses the proof that
the real schemas match the real contracts, the second is the `dist/` assumption this whole design
removes.

## The generator is the consumer's, never a bundled copy

The executors run `@webpieces/openapi-generator` / `@webpieces/docs-site` from the CONSUMER's
`node_modules`, found by walking up from the project the way node does — never a copy inside the nx
plugin (`ConsumerBinResolver`, `src/lib/api-docs` in nx-webpieces-rules). The generator must be the
release the consumer pinned beside the decorators it reads; a bundled copy would be the rules stream's
release, which a repo deliberately runs one release behind.

A version handshake guards the lockstep case: an installed generator older than the capabilities the
executor needs is refused with `@webpieces/openapi-generator >= X.Y.Z` as the cure. A capability always
ships in the generator first; the executor that relies on it follows and raises the minimum in the same
change (`GeneratorPackage`). A workspace link (`0.0.0-dev`, no compiled bin) is not a release and is
refused the same way.

## webpieces-ts itself

This repo does not tag `partner-api` yet: it runs the previous published plugin, and its example app
links the generator as `workspace:*` source, which the handshake refuses by design. That wiring is
[#1019](https://github.com/deanhiller/webpieces-ts/issues/1019). The executors, the tag inference and the
wiring rules are proven by `generated-docs-executors.spec.ts` and `generate-targets.spec.ts`
(nx-webpieces-rules), the loader by `McpToolCatalog.spec.ts` (mcp-server, both layouts), and the
generator by `openapi-golden.spec.ts` (partner-api) in the meantime.
