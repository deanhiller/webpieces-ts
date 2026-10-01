# API documents: opted into with a tag, generated into the build, never committed

Read this when you change a contract (`*Api.ts`, an `@ApiType`, a `{ hidden: true }`), an
`openapi.manifest.json`, anything under `packages/docs/**`, an api library's `project.json`, the
`openapi-generate` / `docs-generate` targets, or how an MCP server loads its tool catalogs. Decided on
issue #986 (phase 6 of #980) and corrected by #1021 and #1023; the issues are the record of why.

## The rule

**An api library's generated OpenAPI documents and MCP tool catalogs are BUILD OUTPUT. They are
written into the outputPath of the library's `build` (its @nx/js:tsc step) and are never committed.** `dist/` is
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
| `generate:openapi-components` | `openapi-components-generate` — a DTO library's `components.openapi.json` (#1058) |
| `generate:docs-site` | `openapi-generate` + `docs-generate` (a site is rendered from a document) |

The plugin owns the executor, `cache`, `inputs` and `outputs`. The consumer states every VALUE in its
project.json under the inferred target name, and nx merges them. Nothing has a default
(`.claude/rules/no-rule-defaults.md`): a missing option is a hard error naming the key. An untagged
project costs one in-memory tag check. A tag the installed plugin does not know is IGNORED, whereas a
project.json naming an executor the installed plugin lacks breaks the graph load — which is why the
opt-in is a tag.

## The api library's shape: tsc stays `build`, dependents carry `^openapi-generate`

nx's own documented codegen shape (https://nx.dev/blog/dotnet-openapi-type-safety), decided on #1023
after #1021's `compile` split broke the first real consumer:

```json
"tags": ["generate:openapi"],
"targets": {
  "build": {
    "executor": "@nx/js:tsc",
    "outputs": ["{options.outputPath}"],
    "options": { "outputPath": "dist/libraries/apis/my-apis", "main": "...", "tsConfig": "..." }
  },
  "openapi-generate": {
    "dependsOn": ["build"],
    "options": { "manifest": "libraries/apis/my-apis/openapi.manifest.json", "format": "both" }
  }
}
```

A DTO library that contract documents reference (#1058) is tagged `generate:openapi-components`, and
every generating target that READS an upstream components document carries `^openapi-components-generate`
— which is what orders a chain of any depth (contract lib → DTO lib A → DTO lib B):

```json
"tags": ["generate:openapi-components"],
"targets": {
  "build": { "executor": "@nx/js:tsc", "outputs": ["{options.outputPath}"], "options": { "outputPath": "dist/libraries/apis/my-dtos", "...": "..." } },
  "openapi-components-generate": {
    "dependsOn": ["build", "^openapi-components-generate"],
    "options": { "manifest": "libraries/apis/my-dtos/openapi.manifest.json", "format": "json" }
  }
}
```

with `{ "kind": "components", "title": "My DTOs", "entries": ["src/index.ts"] }` as its manifest, and the
contract library's `"openapi-generate": { "dependsOn": ["build", "^openapi-components-generate"], … }`.
Both targets take the upstream `components.openapi.json` as a cache input, so a change to a DTO library
regenerates every document downstream of it.

and ONE repo-wide `nx.json` line per targetDefaults entry that governs a `build` or `test` a consumer
runs — keyed the way nx reads it, the EXECUTOR key when one exists, else the target name:

```json
"targetDefaults": {
  "@nx/js:tsc": { "dependsOn": ["^build", "^openapi-generate"] },
  "build":      { "dependsOn": ["^build", "^openapi-generate"] },
  "test":       { "dependsOn": ["^openapi-generate"] }
}
```

**Why the tsc target must keep the name `build`.** `@nx/js:tsc` decides whether each dependency is
buildable by looking for a target with the SAME name as the one running (nx 22,
`buildable-libs-utils.js` `calculateProjectDependencies`). Rename the api library's tsc target
`compile` and every `build`-only dependency looks non-buildable: its SOURCE is pulled into the compile
and tsc fails with TS6059 "rootDir is expected to contain all source files" (nrwl/nx#18257, closed as
outdated, never fixed). The one switch that avoids it, `NX_BUILDABLE_LIBRARIES_TASK_GRAPH=true`, is
undocumented — rejected. So the split is not the design, and there is no `nx:noop` `build`.

**Why the dependents, and why that is cheap.** nx `dependsOn` only points BACKWARD and generation must
run AFTER tsc (whose cleanup wipes the outputPath), so it cannot hang off the library's own `build`.
`^openapi-generate` pulls it in from the other side: nx skips a dependency that has no
`openapi-generate` and keeps walking ITS dependencies, so a project with no generating library upstream
is unaffected and a transitive dependent is reached through the projects between. `test` needs it as
much as `build`: a server spec that boots the MCP server reads the library's generated catalogs out of
its build output.

`validate-nx-wiring` checks this on the RESOLVED project graph: (a) a `generate:openapi` project's
`openapi-generate` dependsOn exactly its own `build`; (b) every project that depends — transitively — on
one has `^openapi-generate` in the effective `dependsOn` of its `build` and `test`; (c) a
`generate:openapi-components` project's `openapi-components-generate` dependsOn exactly its own `build`;
(d) every `openapi-generate` and `openapi-components-generate` that reaches — transitively — a
components-publishing library names `^openapi-components-generate`. A failure names the
`nx.json` targetDefaults key to edit and prints the exact line — or the project.json to edit, when the
project states its own `dependsOn` (nx does not merge it with targetDefaults).

## Where the output goes: ASK nx, never assume `dist/`

The documents go into the `outputPath` of the ONE target `openapi-generate` dependsOn (`build`) — the
loader never hardcodes the target name and never assumes `dist/`. `GeneratedApiDocsLayout` (`@webpieces/core-util`) is
that lookup, and it is the ONE lookup: the executor writes with it, the plugin computes the inferred
`outputs` with it, and `McpToolCatalog.fromPackages` reads a workspace source directory with it. The
measured layouts differ, which is the point:

| repo | build outputPath |
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
- Beside each SPLIT document (`full-private-openapi`, `public-openapi`), its `*.bundled.json` (#1058):
  every schema defined locally, no external reference, valid on its own — for code generators,
  gateways and docs sites that read one file. A docs site reaching DTO libraries is built from the
  bundled document.
- For a DTO library (`"kind": "components"` manifest), `components.openapi.json` alone.

`outputs` are CHECKED, not trusted: the executor generates into a staging directory, so it knows what it
wrote, and refuses when a written file is not covered — a cache hit would otherwise restore a package
without it.

## How generation works: one owner per schema, chained through DTO libraries (#1058)

A schema is defined in exactly ONE document — the one of the package whose source DECLARES the type
(the nearest `package.json` above the declaration). A contract document defines its own package's
types and `$ref`s every other package's into that package's components document:

```json
{ "$ref": "@myorg/lang-api-dtos/components.openapi.json#/components/schemas/PassageItemDto" }
```

- **A DTO library publishes `components.openapi.json`**: `openapi`, `info` (`version` = the package
  version), `x-webpieces-id` (that URI — OpenAPI 3.1's root admits no `$id`, and a 3.1 validator
  rejects one) and `components.schemas` holding EVERY type the library exports and declares. Its
  manifest is `{ "kind": "components", "title": "…", "entries": ["src/index.ts"] }`. A DTO library
  referencing another DTO library does so the same way, so a chain has any depth.
- **The upstream document is located by the `McpToolCatalog.fromPackages` lookup** — node resolution
  from the manifest, then beside a built package's `package.json`, or the `outputPath` of the target a
  workspace source directory's `openapi-components-generate` dependsOn. Never an assumed `dist/`.
- **Fail-closed, for OpenAPI documents only.** A `full-private` / `public` document reaching a type
  declared in a package with no components document is a generation error naming the type, its package
  and the fix: move it into a `role:api-lib` DTO library (as a `…Dto` string enum when it is a literal
  union). Tagging is offered only when the declaring package is ITSELF a `role:api-lib` DTO library:
  `generate:openapi-components` is refused on any other role, by `validate-nx-wiring` and by the
  `openapi-components-generate` executor (#1064, D5), so tagging a general library like `company-core` is
  not a way out. There is no inline allow-list. A referenced schema missing from an existing document is
  refused as stale.
- **MCP never requires a components document.** `mcp-openapi.json` and every `mcp-*-tools.json` inline
  every schema from any package, exactly as before, so an MCP-only consumer tags nothing — and a shared
  DTO renders byte-identically in every catalog.
- **Inheritance is FLATTENED in all three forms** (split, bundled, MCP), consistent with #1056; no
  `allOf`. A base declared in another package contributes its fields to the subclass's own schema.
- Two packages' same-named types are two schemas in two documents; two DIFFERENT types of one name in
  ONE package are still an error. In a bundled document, where both meet, the other package's is
  qualified (`myorg.lang-api-dtos.LocalizedDescriptionsDto`).

`ChainedComponents.spec.ts` (openapi-generator) proves it on a three-level chain, every document
checked by `@seriousme/openapi-schema-validator`.

## The docs site is for HOSTING, not for the package

`docs-generate` (tag `generate:docs-site`) renders the static site into `<projectRoot>/<siteDir>`, e.g.
`generated-docs/`, which the repo gitignores. It is not written into the package: a docs site is
deployed, not installed.

```json
"docs-generate": { "options": { "document": "public-openapi.json", "siteDir": "generated-docs", "prose": "<project>/docs" } }
```

`document` should be the PARTNER-facing document: a site built from `full-private-openapi.json`
publishes exactly the operations somebody decided not to publish. When the contracts reference DTO
libraries, name the self-contained `public-openapi.bundled.json`: the split document's `$ref`s point
into other packages, which a site does not fetch. `siteDir` must lie strictly inside the
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

## Two api roles, and the wire closure (#1064)

`role:api-lib` is a boundary contract and/or its DTOs, with the implementation living elsewhere: an
`@ApiPath`/`@Rpc`/`@PubSub` contract, an IPC contract (`@WpInternal` / `@WpIpcEndpoint`), an in-process
abstract `…Api` behind a DI token, or a DTO-only library. Data-only protocol constants may accompany the
contract; executable functions and concrete implementation classes may not. `role:api-client` is a
contract PLUS its bundled default implementation that talks to an outside system through its SDK (an
abstract `XxxApi`, or an exported `XxxApi` interface implemented by an `XxxClient` registered with
`@provideSingletonDefaultForApi`). `validate-api-lib-tag` keeps both honest; the lattice, the folder map
and the dependency rule for them are in `.claude/rules/framework-tags.md`.

**The wire closure.** Inside the `api-rules-for-openapi` / `api-rules-for-mcp` scan — which already walks
every `@ApiPath` contract through the compiler, no generate tag needed — every named type a contract
reaches must be DECLARED in a `role:api-lib` project and must end in a suffix its `required-type-suffix`
entry demands (when that rule is not OFF). It catches what the dependency rule cannot: a relative-path
import into another library, or a DTO library reaching outside itself. The refusal names the type, its
declaring package and project, and the fix — move it into an api library, as a `…Dto` string enum when it
is a literal union. A type declared in a published package under `node_modules` is that package's to own
and is not judged here.

## One spelling in an api library: string enums, top-of-file imports

A fixed set of string values in an API is a string `enum`, every member explicitly initialised with a
string literal — and nothing else (#1023):

```ts
export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }
gender!: SpeakerGender;                    // the enum
mode: VoiceMode.RANDOM;                    // one member, as a union discriminator
mode: VoiceMode.A | VoiceMode.B;           // a union of members, on one branch
```

The generator renders a string enum as an `enum` of its member VALUES everywhere a type can appear
(a field, an array element, a `Record` value, nested DTOs, request and response roots, MCP tool
schemas), and derives a union's discriminator when a branch's value is one member, one literal, or a
UNION of them — every value maps to its branch. It keeps supporting string-literal unions.

Two `@webpieces/code-rules` rules keep an api library (`role:api-lib`) on that one spelling. Both have
NO default (`.claude/rules/no-rule-defaults.md`) — a consumer states `mode` (`OFF` |
`NEW_AND_MODIFIED_CODE` | `NEW_AND_MODIFIED_FILES` | `MODIFIED_PROJECTS` | `RUN_EVERY_TIME`),
optionally `allowedPaths`, and the universal hatches. The two whole-scope modes (#1027) exist for the
migration a large api library needs: count what is left with
`pnpm exec wp-validate-code --rule=one-enum-spelling-in-api-lib --mode=RUN_EVERY_TIME --projects=<api libs>`
(no config edit; see `docs/ENGINEERING-PRACTICE.md`, Part 3):

- `one-enum-spelling-in-api-lib` refuses a 2+ string-literal union (alias, field, parameter),
  `(typeof X)[number]`, `keyof typeof X`, a single string-literal type used as a union discriminator,
  and a numeric, heterogeneous, `const` or uninitialised enum. Each cure prints the enum to write.
- `no-inline-import-in-api-lib` refuses an `import('…')` type node and a dynamic `import()` expression;
  the cure is the top-of-file `import { X } from '…';`.

A third, `no-utility-types-in-api-lib` (#1026), is scoped by a REQUIRED `paths` glob list (e.g.
`["libraries/apis/**"]`) instead of the role tag, with the same `mode` values. It refuses `Omit`, `Pick`,
`Partial`, `Required`, `Exclude` and `Extract` wherever a type is written — `interface X extends Omit<…>`,
a field, an alias, a generic argument — because each turns a DTO's field list into a computation over
another file. The cure is to write the fields out: a shared base interface both DTOs extend, or a flat
interface or class. The wire JSON is unchanged.

A fourth, `required-type-suffix` (#1037), names the LAYER: every exported interface, class, enum and
type alias under an entry's `paths` must end in one of that entry's `suffixes` — e.g.
`Request | Response | Event | Dto | Api` for `libraries/apis/internal/**` and `Fs` for the Firestore
model libraries. `entries` is required and non-empty, each with non-empty `paths` and `suffixes`; when
entries overlap the FIRST match in `entries` order wins, so a narrower entry must be listed before a
broader one (the full rule, and the example config, are in
`docs/ENGINEERING-PRACTICE.md`, Part 3). Under `NEW_AND_MODIFIED_CODE` only a new or renamed type is
judged, so legacy names are grandfathered.

webpieces-ts's own `webpieces.config.json` states none of the three yet: it runs the previous published release,
whose validator does not know the keys (`.claude/rules/published-vs-local-source.md`). The follow-up
issue, [#1024](https://github.com/deanhiller/webpieces-ts/issues/1024), adds them with the pin bump to the release that ships them.
`required-type-suffix` follows the same order: it ships in source first, and its live entry lands in a
follow-up after the release that carries it is published.
