# Framework and role tags are TRUE, and the machine says so

Read this when you add or change a `framework:*` or `role:*` nx tag, the framework lattice, the
`role:api-lib` / `role:api-client` split, or one of the five tag-truth rules. Decided by Dean on issue
[#1064](https://github.com/deanhiller/webpieces-ts/issues/1064) (D1–D10), from measurements in the
reference consumer (`ctoteachings/monorepo`); the consumer half is ctoteachings/monorepo#1553.

## The problem

A tag used to be a promise only the dependency graph checked. Nothing compared it with the code inside
the library (a `browser+node` library could import `fs`), the folder it lives in (the consumer's folders
had drifted from the tags), or the types its API contracts put on the wire (`AiProvider` reached the wire
from a general library, and no api-lib rule could see it, because every one of them only reads files
INSIDE the api library). Each rule below closes one of those gaps.

## The framework lattice

A project's `framework:` tags are its env SET — every runtime it promises to run in. An edge consumer →
library is legal when every consumer env resolves to itself or an ancestor the library carries
(`library-types-match-client`):

| env | consumes from |
|---|---|
| `react`, `angular` | itself, `browser` |
| `browser` | `browser` |
| `express` | itself, `node` |
| `node` | `node` |
| `react-native` | `react-native` ONLY |

`react-native` is a first-class runtime and **not** a specialisation of browser (D6): it has no DOM, no
IndexedDB, no OPFS. A react-native app consumes only libraries that are themselves tagged
`framework:react-native` — a universal `browser+node+react-native` library, a `browser+react-native`
one, or a react-native-only one. Inferred from package.json, `react-native` wins over `react`.

## The roles

| role | is |
|---|---|
| `role:api-lib` | a boundary contract and/or its DTOs, implementation elsewhere: `@ApiPath`/`@Rpc`/`@PubSub`, an IPC contract (`@WpInternal`/`@WpIpcEndpoint`), an in-process abstract `…Api` behind a DI token, or a DTO-only library; data-only protocol constants may accompany the contract |
| `role:api-client` | a contract PLUS its bundled default implementation that talks to an outside system through its SDK (`XxxApi` abstract class, or exported `XxxApi` interface implemented by an `XxxClient` registered with `@provideSingletonDefaultForApi`; each method through `LogApiCallImpl.execute`) |

The split is deliberate (D1): it puts "talks to an outside system" on the architecture graph.
`validate-api-lib-tag` keeps both honest — an `@ApiPath` contract must carry one of the two roles; a
`role:api-lib` must export a contract or only wire types (interfaces, aliases, enums, data classes); it may
also export literal/structural protocol data, but not functions, function-valued constants, or concrete
classes with behavior. `role:api-client` must export its proven contract. Streaming / listening external
APIs are not supported yet.

## The five tag-truth rules

None has a default (`.claude/rules/no-rule-defaults.md`): each must be stated in `webpieces.config.json`
or the config fails to load. The values below are the SEEDS a fresh config gets, and the reference
consumer's layout.

### `api-lib-dependencies` (D2) — graph rule, `OFF | RUN_EVERY_TIME`

A `role:api-lib` depends only on other `role:api-lib` projects plus `apiLibPackages`; a
`role:api-client` may also import what its own `apiClients` entry lists. A `role:api-client` with no
entry is itself refused. Production imports are parsed from source syntax (specs do not count and prose
cannot become an import), so a node builtin is an outside package like any other; `node:fs` canonicalizes
to the allow-list spelling `fs`.

```json
"api-lib-dependencies": {
  "mode": "RUN_EVERY_TIME",
  "apiLibPackages": ["@webpieces/core-util", "tslib"],
  "apiClients": [
    { "project": "gmail", "packages": ["googleapis", "inversify", "@webpieces/core-context"] }
  ],
  "turnOffRuleUntilEpoch": 0, "turnOffRuleWhileOnBranch": null
}
```

### `api-lib-path` (D10) — graph rule

Both directions: every `role:api-lib` / `role:api-client` lives under `paths`, and every project under
`paths` carries one of those roles. `"paths": ["libraries/apis/**"]`.

### `framework-folder` (D9) — graph rule

The FIRST entry whose glob matches a project's root governs it: the project must carry one of its
`frameworkSets` (tags joined by `+`, any order) and one of its `roles`. And a library (any role but an
app's) carrying a set and role some entry lists must live under one of those entries. The recommended
layout:

| glob | framework set | role |
|---|---|---|
| `libraries/angular/**` | angular | lib / designed-lib |
| `libraries/node/**` | node **or** express | lib / designed-lib |
| `libraries/universal/**` | browser + node + react-native | lib / designed-lib |
| `libraries/rn-browser/**` | browser + react-native | lib / designed-lib |
| `libraries/react-native/**` | react-native | lib / designed-lib |
| `libraries/apis/internal/**` | browser + node + react-native, ALWAYS — every contract is usable by anyone | api-lib |
| `libraries/apis/external-node/**` | node | api-client |
| `libraries/apis/external-rn-browser/**` | browser + react-native | api-lib (contract only; implementation in the apps) |

### `framework-tsconfig` (D7) — code rule, `OFF | MODIFIED_PROJECTS | RUN_EVERY_TIME`

The COMPILER enforces the runtime: a library's `tsconfig.lib.json` (with its `extends` chain) must resolve
to

| framework set | `compilerOptions.lib` | `compilerOptions.types` | effect |
|---|---|---|---|
| browser only (browser / angular / react) | `["es2022", "dom"]` | `[]` | `fs`, `process`, `__dirname`, `Buffer` do not compile |
| node only (node / express) | `["es2022"]`, no dom | `["node"]` | `window`, `document`, `localStorage`, `navigator` do not compile |
| universal (browser + node + react-native) | `["es2022"]` | `[]` | pure TypeScript |
| browser + react-native | `["es2022"]` | `[]` | no DOM globals (RN has none), no node |
| react-native | `["es2022"]` | `[]` (RN types in apps) | no DOM, no node |

The rule checks the `dom` and `node` axes; the ES version is yours. An UNSET `lib` is TypeScript's
default, which includes `dom`, and an unset `types` loads every `@types/*`, so a library whose runtime
excludes either must state both.

### `framework-packages` (D8) — code rule, `OFF | MODIFIED_PROJECTS | RUN_EVERY_TIME`

A framework package is imported only by a project whose EVERY framework tag its entry allows. Production
source only; a package no entry names is not judged; the per-site hatch is
`// webpieces-disable framework-packages -- <reason>` on or above the import.

```json
"entries": [
  { "packages": ["@angular/*"], "frameworks": ["angular"] },
  { "packages": ["react", "react-native", "expo*", "@expo/*", "@sentry/react-native"], "frameworks": ["react", "react-native"] },
  { "packages": ["express", "firebase-admin", "googleapis", "google-auth-library", "@google-cloud/*"], "frameworks": ["node", "express"] },
  { "packages": ["firebase"], "frameworks": ["browser", "angular", "react"] }
]
```

## Related: the wire closure and `generate:openapi-components`

Every type an `@ApiPath` contract reaches must be declared in a `role:api-lib` project and carry its
`required-type-suffix` suffix (D4), and `generate:openapi-components` is refused on anything but a
`role:api-lib` (D5). Both are described in `.claude/rules/api-docs.md`.

## Release ordering

These rules ship in SOURCE first (`.claude/rules/published-vs-local-source.md`). This repo's own
`webpieces.config.json` gains the five entries — and this repo's projects their retags — only in a
follow-up PR after the release that carries them is published and the pin is bumped: the running
validator is one release behind and would reject the unknown keys. That follow-up is
[#1065](https://github.com/deanhiller/webpieces-ts/issues/1065).
