# Claude Code Guidelines for webpieces-ts

This document contains guidelines and patterns for Claude Code when working on the webpieces-ts codebase.

## Core Principles

### 1. Classes Over Interfaces for Data Structures

**RULE: All data-only structures MUST be classes, not interfaces.**

**What is a data-only structure?**
- Contains only fields/properties
- No methods with business logic
- Used purely for data transfer or configuration

**Examples of DATA ONLY (use classes):**
- `ClientConfig` - Configuration data
- `FilterDefinition` - Filter metadata
- `RouteDefinition` - Route metadata
- `RouteRequest` - Request data
- `RouteContext` - Context data
- `MethodMeta` - Method metadata
- `Action` - Response data
- `RouteMetadata` - Route decorator metadata
- `JsonFilterConfig` - Configuration data
- `RegisteredRoute` - Extended route data

**Examples of BUSINESS LOGIC (use interfaces):**
- `Filter` - Has `filter(meta, next)` method with logic
- `Routes` - Has `configure(routeBuilder)` method with logic
- `RouteBuilder` - Has `addRoute()`, `addFilter()` methods
- `WebAppMeta` - Has `getDIModules()`, `getRoutes()` methods
- `SaveApi` - Has `save(request)` method with logic
- `RemoteApi` - Has `fetchValue(request)` method with logic
- `Counter` - Has `inc()`, `get()` methods with logic

**Why classes for data?**
1. No anonymous object literals - explicit construction
2. Better type safety
3. Clear instantiation points
4. Easier to trace in debugger
5. Can add validation/defaults in constructor

**Pattern:**
```typescript
// BAD - Interface for data
export interface UserData {
  name: string;
  age: number;
}

const user = { name: 'John', age: 30 }; // Anonymous object literal

// GOOD - Class for data
export class UserData {
  name: string;
  age: number;

  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
}

const user = new UserData('John', 30); // Explicit construction
```

### 2. Filter Chain Architecture

**Pattern inspired by Java webpieces:**

The filter system uses filepath-based matching:
- Filters are registered with glob patterns (e.g., `'src/controllers/admin/**/*.ts'`)
- `FilterMatcher` matches filters to routes based on controller filepath
- Filters without a pattern (or pattern `'*'`) apply globally
- Filter matching happens at startup (no runtime overhead)

**Key classes:**
- `FilterDefinition(priority, filterClass, filepathPattern)` - Filter registration
- `FilterMatcher.findMatchingFilters()` - Pattern matching logic
- `FilterChain` - Executes filters in priority order

**Example:**
```typescript
export class FilterRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    // Global filter (pattern '*' matches all)
    routeBuilder.addFilter(
      new FilterDefinition(140, ContextFilter, '*')
    );

    // Admin-only filter
    routeBuilder.addFilter(
      new FilterDefinition(100, AdminAuthFilter, 'src/controllers/admin/**/*.ts')
    );
  }
}
```

### 3. No Anonymous Object Literals

**RULE: Avoid anonymous object structures - use explicit class constructors.**

**BAD:**
```typescript
routeBuilder.addRoute({
  method: 'POST',
  path: '/api/save',
  handler: myHandler,
});
```

**GOOD:**
```typescript
routeBuilder.addRoute(
  new RouteDefinition('POST', '/api/save', myHandler)
);
```

#### The one carve-out: DECORATOR arguments that encode a compiler-enforced choice

A decorator argument may be an object literal typed by a **discriminated union**, when the union is what
makes an invalid combination fail to compile:

```typescript
@AuthJwt({ roles: ['admin'] })         // ✅ role-gated
@AuthJwt({ allRolesAllowed: true })    // ✅ every authenticated user, said out loud
@AuthJwt({})                           // ❌ compile error — pick a branch
@AuthJwt({ roles: [] })                // ❌ compile error — needs at least one role
```

This is not a loophole for skipping a class, and it does not apply to configs, definitions, or DTOs —
those still take a class. It exists because **a class cannot express this guarantee.** A class is one
shape: to cover both branches you would need either two classes (which is the "two spellings" shim the
compatibility policy rejects) or one class plus a runtime `throw` (which is shim shape #4 — a throw
standing in for a type that cannot express the bad state). The union is the only form where the invariant
is enforced at the moment the line is written, and that moment is the only one that changes what an agent
writes.

The test for whether the carve-out applies: **delete the union and ask what enforces the rule instead.**
If the answer is "a runtime check" or "a code review", use the union. If the answer is "nothing was being
enforced, it is just a bag of fields", use a class. `@Endpoint(..., { calledBy })` and
`JwtRequirement`'s app-defined fields are the existing precedent.

### 4. Type Safety

- Use `unknown` instead of `any` for better type safety
- Use generics for type-safe route handlers: `RouteHandler<TResult>`
- Prefer explicit types over inference when defining public APIs

### 5. Dependency Injection

**Use Inversify for DI:**
- `@injectable()` - Mark classes as injectable
- `@provideSingleton()` - Register singleton in container (preferred over `@injectable` alone)
- `@unmanaged()` - Mark constructor params that aren't injected

**Prefer inject-by-type over Symbol tokens:**

Annotate the implementation class with `@provideSingleton()` and inject it by its concrete class type — no `Symbol()` token, no `@inject(TOKEN)` call needed:

```typescript
@provideSingleton()
export class IdentityResolver { ... }

@provideSingleton()
export class MyService {
  constructor(private readonly identityResolver: IdentityResolver) {}
}
```

**`Symbol()` DI tokens are blocked by `no-symbol-di-tokens`** (enforced via `@webpieces/ai-hook-rules` PreToolUse hook and `@webpieces/code-rules` NEW_AND_MODIFIED_CODE gate). Allowed paths are configured in `webpieces.config.json` under `no-symbol-di-tokens.allowedPaths`. Defaults:
- `libraries/apis/**` — define Symbol token alongside the API interface
- `packages/http/http-api/**` — framework primitives (e.g. `Symbol.for` multiInject)

Choose the right pattern by use case:
- **Own class** → `@provideSingleton()` + inject by type. No Symbol.
- **`libraries/apis-external/**` impl** → import the Symbol from `libraries/apis/**` and annotate with `@provideSingletonDefaultForApi(TOKEN)`. No new Symbol creation in `apis-external`.
- **External library class you cannot decorate** (DataSource, Anthropic SDK, etc.) → bind in a ContainerModule using the class itself as the token: `bind<Anthropic>(Anthropic).toDynamicValue(() => new Anthropic({...})).inSingletonScope()`. Inject by type — no Symbol, no `@inject`.
- **Unavoidable** → add `// webpieces-disable no-symbol-di-tokens -- <reason>` to the line.

### 6. Decorators

**API Decorators (shared between client and server):**
- `@ApiInterface()` - Mark API prototype class
- `@Post()`, `@Get()`, `@Put()`, `@Delete()`, `@Patch()` - HTTP methods
- `@Path('/path')` - Route path

**Server-only Decorators:**
- `@Controller()` - Mark controller class
- `@SourceFile('path/to/controller.ts')` - Explicit filepath for filter matching
- `@provideSingleton()` - Register as singleton (binds class to itself)
- `@provideSingletonDefaultForApi(TOKEN)` - Register as the default (overridable) singleton implementation of TOKEN; use in `libraries/apis-external/**` with a Symbol imported from `libraries/apis/**`

### 7. Testing

**Unit tests:**
- Test filter matching logic in isolation
- Mock dependencies using classes
- Verify priority ordering

**Integration tests:**
- Use `WebpiecesServer.createApiClient()` for testing without HTTP
- Test full filter chain execution
- Verify end-to-end behavior

### 8. Documentation

- Use JSDoc for all public APIs
- Explain WHY, not just WHAT
- Include usage examples
- Document differences from Java version when applicable

## Common Patterns

### Creating a New Filter

```typescript
import { injectable } from 'inversify';
import { Filter, MethodMeta, Action, NextFilter } from '@webpieces/http-filters';

@injectable()
export class MyFilter implements Filter {
  priority = 100;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Before logic
    console.log(`Request: ${meta.httpMethod} ${meta.path}`);

    // Execute next filter/controller
    const action = await next.execute();

    // After logic
    console.log(`Response: ${action.statusCode}`);

    return action;
  }
}
```

### Creating a New Controller

```typescript
import { provideSingleton, Controller } from '@webpieces/http-routing';

@provideSingleton()
@Controller()
export class MyController extends MyApiPrototype implements MyApi {
  private readonly __validator!: ValidateImplementation<MyController, MyApi>;

  async myMethod(request: MyRequest): Promise<MyResponse> {
    // Implementation
  }
}
```

### Registering Routes and Filters

```typescript
export class MyRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    // Register filters
    routeBuilder.addFilter(
      new FilterDefinition(140, ContextFilter, '*')
    );

    // Register API routes
    // (handled automatically by RESTApiRoutes)
  }
}
```

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                 WebAppMeta                      │
│  - getDIModules() - Returns DI modules         │
│  - getRoutes() - Returns route configurations  │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              WebpiecesServer                    │
│  - Initializes DI containers                   │
│  - Registers routes using RouteBuilder         │
│  - Matches filters to routes (FilterMatcher)   │
│  - Creates filter chains per route             │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│               FilterChain                       │
│  - Executes filters in priority order          │
│  - Wraps controller invocation                 │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│              Controller                         │
│  - Implements API interface                    │
│  - Business logic                              │
│  - Returns response                            │
└─────────────────────────────────────────────────┘
```

## Key Differences from Java Version

1. **Glob patterns instead of Regex**: TypeScript uses glob patterns for filepath matching
2. **Class-based data structures**: All data structures are classes, not interfaces
3. **Decorator-based metadata**: Uses TypeScript decorators instead of annotations
4. **Inversify instead of Guice**: Different DI framework but similar patterns
5. **Class name fallback**: Since TypeScript doesn't provide source paths at runtime, we use class name patterns like `**/SaveController.ts`

## When Adding New Features

1. **Check for data-only structures** - If it's just data, use a class
2. **Add filter matching support** - Consider if filters need to scope to it
3. **Write tests first** - Unit tests for logic, integration tests for behavior
4. **Update documentation** - Keep this file and claude.patterns.md up to date
5. **Follow existing patterns** - Look at similar features for consistency
6. **Post the PR** - The feature is not done until the PR is up (see "Finishing a Feature" below)

## Build Verification (CRITICAL)

**RULE: verify with `pnpm wp-build`. Never build the whole monorepo, and never hand-compose a verify
chain of your own.**

```bash
pnpm wp-build
```

That runs `commands.pr-gate.buildCommand` from `webpieces.config.json` **verbatim** — through the same
resolver the PR gate's own build stage uses, so a green result locally is evidence about the gate. It
prints the command it resolved before running it, so you always know what actually ran. A
whole-workspace build is a *different, wider* command whose green tells you nothing extra — it only also
compiles projects your change cannot reach.

**The build's output goes to a log FILE, not to your terminal.** The console gets a heartbeat (`… size
100 lines`, plus `still` when the count has not moved) and then one summary — `Build success` or
`Build Failed:`, the absolute `FullLog :` path, and a note that the previous run is kept beside it as
`build.log.bak`. Both are gitignored with the rest of `.webpieces/`.

**Read the log at the absolute `FullLog :` path THIS run printed — never type a path from memory.**
`grep -n error "<the FullLog path>"` always works; a remembered relative path silently greps nothing,
which reads exactly like a clean build.

Where that file actually lands — primary clone vs linked worktree, `wp-build` vs the PR gate's stages —
is **`.webpieces/instruct-ai/webpieces.buildlog.md`**, regenerated on every `wp-*` command. Read it
there rather than here: the namespacing is webpieces' to change, this file is hand-written, and a path
copied into a hand-written file is exactly the thing that goes stale under us (see the corollary in
"webpieces.config.json is NEVER released backwards-compatible").

**So read the FILE; never re-run the build to see a different slice of it.** That is the whole reason
the log exists: one measured session spent 23.9 minutes across nine builds, five of them with no code
change in between, walking `| tail -50` → `> /tmp/file` → `| grep` → `| sed -n '1100,1230p'` over
output that had already scrolled past. Every one of those is a `grep` of the `FullLog :` file now, and
the run before it is still on disk as `.bak`.

`wp-build` ships from `@webpieces/pr-gate`, so like every other `wp-*` bin it arrives with a RELEASE —
see "Published vs local source" below. If `pnpm wp-build` says *command not found* in this repo, the pin
in `pnpm-workspace.yaml` is simply older than the release that added it; run the resolved command it
wraps (`commands.pr-gate.buildCommand`) until the next publish + `pnpm install`. That is the ordinary
one-release lag, not a broken install.

**Do not assemble your own verify chain.** `wp-build` deliberately runs one command and adds no
format/lint/test leg of its own, because that composition is exactly what drifts: a sibling repo's
`ci:local` grew into `prettier --check .` + `wp-ci` + `nx affected -t test` with no `--base` — three
whole-world passes on every inner loop, none of them the command the gate runs. If something must run on
every build, it belongs *inside* `buildCommand`, where the gate runs it too.

Tighter loops, for while you are actually writing code:

```bash
pnpm exec vitest run <path>          # one spec file or one directory — the inner loop
pnpm nx run <project>:test           # one project's tests
pnpm nx run <project>:ci             # one project, full gate
pnpm nx run-many -t ci -p a b        # a couple of projects, named explicitly
```

`pnpm run build-all` (and `nx run-many` with no `-p`, `nx affected` with no `--base`, and a bare
`pnpm exec vitest run`) is what `whole-repo-build-guard` refuses, naming `pnpm wp-build` in its place.
That guard is **EXPERIMENTAL and OFF unless this machine opts in** — the one thing that turns it on is

```json
{ "experimental": { "whole-repo-build-guard": true } }
```

in the optional, untracked `~/.webpieces/config.json`. There is no `webpieces.config.json` entry for it.
A missing file, a missing `experimental` section, a missing key and an explicit `false` are all the same
state: OFF. That direction is policy — every `experimental.*` flag ships OFF and stays OFF for two
years. The rule above holds either way: run `pnpm wp-build`, guard or no guard. The `build-all` script
stays in `package.json` on purpose — a human running it once is fine; an agent running it in a loop is
the problem, and a PreToolUse hook only ever sees the agent.

### Does `affected` cover the workspace-global validators?

**Yes — verified, not assumed.** The architecture / dependency-graph / nx-wiring / versions-locked /
runtime-architecture validators all hang off `architecture:validate-complete`, and **every project's
`ci` target `dependsOn` it** (see `createCiTarget` in the nx plugin). So the moment *any* project is
affected, one `nx affected --target=ci` run schedules the whole `architecture:validate-*` set. A
tooling-only change on this branch scheduled 47 tasks across 7 projects, including all eleven
`architecture:*` validators. There is no class of check that only a whole-workspace run reaches.

The one thing that is genuinely repo-wide and does NOT ride on a project's `ci` is the
"regenerated design files are committed" check — and that runs in `pnpm wp-review-upsert-pr`, so the
gated flow covers it for you.

### What actually makes builds slow (it is not the target list)

Do not expect `affected` to be fast just because it is narrower — measured honestly:

- For a change in a **base** package (`core-util`, `core-context`), `affected` can select **nearly
  everything**: on one measured `core-util` change it selected the identical 20 projects / 104 tasks
  the whole-workspace build did. Nothing sits below it in the graph, so nothing prunes. The pruning
  win is real for **leaf** projects and roughly zero for base ones.
- The long builds people blamed on scope were **cold nx cache** and **CPU contention between agents
  running full sweeps at the same time** — measured at ~3.2x total test time under contention, with
  individual suites 3x slower than the same suite minutes later on an idle box. A narrower target
  list does not fix either.

Practical consequence: a full `pnpm exec vitest run packages apps` sweep is expensive under
contention. Run it **once**, before you post the PR — not after every edit. During the edit loop, run
the one spec file you are changing.

**Contention is now MEASURED, not guessed at, and `wp-build` acts on it.** Every build on this machine
— `wp-build` and both PR-gate stages — writes a row to one machine-wide ledger, and `wp-build` REFUSES
when the box is already at its limit rather than making a fourth build everybody's problem. The gate
stages are never refused. When you meet that refusal, take its first cure: run the gate you were going
to run anyway, which runs the same `buildCommand`. **`.webpieces/instruct-ai/webpieces.buildlog.md` has
the ledger's location, its row format, the grep recipes, the limit's config key and the `--force`
escape** — read it there, not here, for the reason in the corollary below: a path copied into this
hand-written file is exactly what goes stale on the next release.

**A green build is NOT the finish line.** None of those greens mean the work is ready for review.
When the feature is actually complete, proceed to "Finishing a Feature" — do not stop at a green
build.

### Published vs local source (the one-release lag)

This repo **dogfoods the published `@webpieces/*` packages**. `node_modules/@webpieces/*` are real
published copies (verified: real directories, not symlinks into local `dist/`), and they are always
**one release behind** the local source in `packages/tooling/**` — published `0.4.x` vs a local
`0.0.0-dev`.

TypeScript and vitest do NOT see it that way. `tsconfig.base.json` maps `@webpieces/*` to
`packages/tooling/**/src/index.ts`, so type-checking and unit tests exercise your **local** changes.
Almost everything else runs the **published** copy:

| Runs the PUBLISHED copy | Consequence |
|---|---|
| nx executors (`architecture:generate`, `di-graph-generate`, `validate-*-unchanged`) | local `nx-webpieces-rules` changes are invisible to `pnpm arch:generate` and to the build's `validate-*-unchanged` gates |
| `wp-*` bins (`wp-ci`, `wp-start-upsert-pr`, `wp-review-upsert-pr`, `wp-finish-upsert-pr`, `wp-cleanup`) | running one is **not** an end-to-end test of unreleased `pr-gate` / `code-rules` changes |
| PreToolUse hooks (`wp-ai-rules-hook`, `wp-ai-guards-hook`) | guard changes take effect only after publish + `pnpm install` |
| the ESLint `@webpieces` plugin | a rule named in the live config before publish fails the graph load |

**What this means in practice:**

- **Verify plugin/rule changes with the package's own vitest suite** (tsconfig paths → local src), NOT
  by regenerating artifacts. Regenerated `architecture/*`, `design.json` and `design.html` have to wait
  until after publish.
- **Do not add a new `webpieces.config.json` key in the same PR that adds the rule.** The published
  validator does not know the key, rejects it as an unknown rule, and that blocks every Bash/Edit —
  a deadlocked session. Ship the source, publish, then a follow-up PR adds the live config entry.
- **A green build does not prove your plugin change took effect.** If
  `validate-architecture-unchanged` stays green after you changed graph-producing code, the likely
  reason is that the executors ran the OLD published plugin — not that your change was a no-op. Look at
  `node_modules/@webpieces/<pkg>` before concluding anything.
- If a validator rejects a config key as UNKNOWN, **delete the key** — that is the primary cure, and
  `pnpm wp-prune-unknown-config` does it mechanically. A key no running validator has a schema for
  controls nothing, and for a RETIRED key deletion is the whole fix. The stale-validator case (the key is
  valid, your pin is behind) never reaches that message: the version-drift guard catches it first and
  prescribes its own cure, so `pnpm install` is not the answer to a validation error.

**A linked worktree does not get its own RELEASE — there is ONE governor per repo.** `git worktree add`
copies no `node_modules`, so until something installs there a worktree resolves `@webpieces/*` by walking
up to the MAIN tree's install and runs the MAIN tree's binary.

**That is about the RELEASE, not about `node_modules`.** A worktree may perfectly well have its own —
nx, vitest and the eslint plugin all execute in that tree and load from it, and `pnpm add <anything>`
creates one as a matter of course. Installing in a worktree is fine. The one invariant is that its
`@webpieces` version must **EQUAL** the main tree's, and when it does not the guards **BLOCK**
(`trinary-version-skew`) rather than silently governing the tree with a release it never pinned. The pin
is TRACKED, so the same git hash gives the same pin — `git pull` both trees onto the same main, then
`pnpm install` in each tree that has a `node_modules`, or just work in the main tree. A separate CLONE is
the answer to "I genuinely need a DIFFERENT version" — never to "I need to install here".

### No bin shims — every `bin` lives in `publishConfig.bin`

**RULE: a package declares its executables in `publishConfig.bin`, pointing at compiled TypeScript
(`./src/**/<entry>.js`). NEVER a top-level `bin`, and NEVER a committed `.js` shim.**

The hazard this defuses: pnpm `chmod`s every `bin` target while it links a package, and a `workspace:`
sibling is linked from its SOURCE directory, where `src/` holds only `.ts` until tsc runs. A top-level
`bin` pointing at compiled output therefore makes every `pnpm install` print
`WARN Failed to create bin ... ENOENT ... chmod` — 28 of them on this workspace, noise indistinguishable
from a real bin-link failure.

`publishConfig.bin` removes the hazard instead of working around it: the source manifest declares no
`bin`, so there is nothing for pnpm to chmod, and the published manifest gets one anyway.

**THE HOIST IS DONE BY `scripts/publish-packages.sh`, NOT by the package manager.** `pnpm pack` and
`pnpm publish` hoist `publishConfig.bin` into `bin` on their own — but **CI publishes with
`npm publish dist/<dir>`, and npm does NOT**. It treats `publishConfig.bin` as an unknown key and leaves
it there. Verifying the move with `pnpm pack` therefore proved nothing about the release, and **0.4.575
shipped with no `bin` at all in any of the four packages** — every `wp-*` command gone. So the script
hoists it into the DIST manifest before publishing (the ENOENT hazard is a property of the SOURCE tree —
pnpm never links from `dist` — so the published manifest can carry an ordinary `bin` with no downside),
and then FAILS THE RELEASE if any package whose source declares bins would publish a different number.

The general rule that incident bought: **verify a packaging change against the artifact the RELEASE
pipeline produces, not the one your local package manager produces.**

That matters because the two earlier cures were both worse than the disease, and the second one shipped
a live incident:

- **A committed `.js` shim per bin.** Seventeen files exempt from `no-js-files`, carrying none of the
  TypeScript rules this repo enforces.
- **Deleting the `workspace:` dependency instead** (PR #585). `@webpieces/ai-hook-rules` and
  `@webpieces/pr-gate` are not imported by `nx-webpieces-rules` — they are BUNDLED by it — so they read
  as phantom deps and were removed. One release later they were gone from every consumer's tree,
  `wp-ai-guards-hook` vanished from `node_modules/.bin`, and the L0 shim blocked every tool call while
  prescribing a `pnpm install` that could not possibly help (fault `U`).

`bin-targets-exist.spec.ts` and `umbrella-bundles-all.spec.ts` (nx-webpieces-rules) enforce both halves
and need no maintenance. `setupDebugging.md` is a HISTORICAL journal of an abandoned postinstall
approach; its shim advice is superseded by this section.

### The umbrella: consumers depend on ONE package

**RULE: `packages/tooling/*` depend on each other with `workspace:*`. The ROOT manifest depends on the
PREVIOUS RELEASE of `@webpieces/nx-webpieces-rules` alone, via the one `catalog:` entry in
`pnpm-workspace.yaml`.**

These are two different things and conflating them is what caused the incident above:

| | specifier | why |
|---|---|---|
| BUILDING the tooling | `workspace:*` between `packages/tooling/*` | built against local source; this is also what draws `nx-webpieces-rules` above its five children in `architecture/dependencies.json` — nx only draws workspace→workspace edges |
| RUNNING the tooling on this repo | `catalog:` in the ROOT manifest | the repo is validated by the previous published release (see "Published vs local source") |

`nx-webpieces-rules` is tagged `role:bundle`: it aggregates `ai-hook-rules`, `code-rules`,
`eslint-rules`, `pr-gate` and `rules-config`, so **one** dependency line delivers every `wp-*` bin, every
eslint rule and every nx executor. A consumer repo should never name the children directly.

So the catalog needs exactly one entry — the umbrella pins its children in lockstep, by construction, and
listing them separately is five more versions to keep in step plus an invitation to the partial bump the
L0 drift guard exists to catch. **Bumping the release the repo is built with is a one-line edit in
`pnpm-workspace.yaml`.**

A dependency nothing imports is not automatically phantom. For a `role:bundle` package the
`dependencies` block IS the product.

### NO webpieces surface is released backwards-compatible

**RULE: when a webpieces surface changes, the OLD spelling must STOP COMPILING, and the compile error must
name the new spelling. No deprecation period, no overload, no fallback, no alias — on any surface.**

The config section below is the oldest instance of this rule, not a special case. It applies identically to
decorators and API contracts (`core-util/src/http/decorators.ts`, `libraries/apis/**`, every `*Api.ts`), the
http surfaces (`http-api`, `http-routing`, `http-server`, `http-filters`, `http-client*`), the cloud
surfaces (`cloudtasks-client` queue/enqueue/delivery, `gcp-identity`), `core-context` / `core-util` /
`core-mock`, the logging adapters, all of `packages/tooling/**`, and **every `src/index.ts` barrel** — a
barrel is the surface, so an export left behind after the implementation is deleted is the same defect one
level out.

**Why this repo inverts the normal rule: an agent picks whatever typechecks.** `@deprecated` is a
human-facing signal — strikethrough in an editor, a lint warning someone might read. It is not part of the
type, so it is invisible at the moment an agent decides what to write. The consequence is not "slower
migration", it is **no migration**: an accepted shape is never migrated. And the upgrade side is the cheap
side now — a mechanical rewrite across a repo is exactly what agents do reliably in one pass. So the compile
error is not the cost of the change; it IS the delivery mechanism for it.

Issue #589 is the live proof: an agent wrote `@Authentication(new AuthenticationConfig(true))` — the widest
possible grant — onto an **admin** contract, then asserted in a comment that the framework had no role
support. `@AuthJwt({roles: ['admin']})` was two hundred lines above the file it was editing. Deprecating
`AuthenticationConfig` would have fixed the docs and left the silent over-permissioning fully available.
Deleting it turned every such call site into a compile error.

**The six shim shapes that are an automatic reject** (full detail, with what to grep, in
`.claude/review/backwards-compatibility.md`):

1. **Two spellings of one thing** — a new API added while the old one stays exported; an overload or an
   optional parameter that exists only to keep old call sites compiling; a second config key meaning what an
   existing one means; a class kept as an alias of its replacement. The test for whether a pair is a shim:
   *can a caller pick either one and get the same behaviour?* If yes it is a shim. Better still, make the
   TYPE unsatisfiable in the bad cases so there is exactly one spelling per decision — `JwtRoles` does
   this: `@AuthJwt({roles:['admin'], allRolesAllowed:false})` does not compile, precisely because it would
   be a second spelling of a decision that already has one.
2. **`@deprecated` instead of deletion** — any new `@deprecated` on a surface. Delete it and let callers fail.
3. **A config fallback accepting the old shape** — the section below.
4. **A runtime `throw` standing in for a type that cannot express the bad state** — the throw is evidence the
   signature is wrong. Always ask whether a discriminated union could delete it. `JwtRoles` is the worked
   example: `roles?: never` on the wide branch and a non-empty tuple `readonly [string, ...string[]]` on the
   narrow one make every contradictory or under-specified combination a COMPILE error, so the validation is
   deleted rather than kept as a backstop. Pin it with one `@ts-expect-error` per bad case — tsc fails the
   build with TS2578 if any ever starts compiling. **Put those in a COMPILED file, never a `.spec.ts`:**
   `tsconfig.lib.json` excludes specs and vitest strips types with esbuild, so a `@ts-expect-error` in a spec
   is inert and the suite passes either way. See `core-util/src/http/AuthJwtCompileAssertions.ts`.
5. **A widening that is an ABSENCE rather than a token** — an empty array / omitted argument / falsy default
   that means "allow everything" makes the permissive path the shortest thing to type and impossible to grep.
   Name it: `@AuthJwt({allRolesAllowed: true})`, so `grep -rn allRolesAllowed` lists every wide endpoint.
   Close the side doors too — the first cut of this closed `@AuthJwt` and left `@Auth({})` reaching the
   identical grant, which is why `@Auth` was folded into `@AuthJwt`. One decorator per credential kind.
6. **An error message or doc that teaches the removed API** — the framework's own "you forgot authorization"
   error used to hand the caller `@Authentication(new AuthenticationConfig(...))`, which is a plausible route
   by which that footgun spread. Every message, docstring, `README.md` and `responsibilities.md` naming a
   removed symbol is updated in the SAME diff.

**Enforcement:** `backwards-compat-reviewer` is a REQUIRED review checklist
(`commands.pr-gate.checklists` in `webpieces.config.json`) on every PR touching `packages/**`,
`libraries/apis/**`, any `*Api.ts`, or the config. A red verdict from it blocks the PR, and its `output`
names the file, the old spelling, and the deletion that should have replaced it. Do not argue a shim past it
on the grounds that it is temporary — that is the argument that kept this repo's own config on dead shapes
for releases.

Deleting a surface is only DONE when: the definition is gone, every barrel export is gone, every call site is
migrated (grep the old symbol over `packages apps libraries`), every message/doc that named it is updated,
and a test asserts the NEW error text and that the old symbol is not named.

### webpieces.config.json is NEVER released backwards-compatible

**RULE: when a config key moves, is renamed, or is deleted, the loader REJECTS the old shape with an error
naming the destination. Never add a fallback that accepts both.**

No `?? legacyKey` chain, no alias table applied before validation, no "still accepted for back-compat until
every consumer migrates". This is safe here in a way it is not for a normal library, because of who the
consumer is: **every reader of this file is a coding agent.** The config is validated on startup, the agent
is handed the exact edit, and it applies it in one pass — so the upgrade is seamless *without* shipping a
compatibility layer. Error text SHOULD say "X moved to Y"; that instruction is what makes the fallback
unnecessary.

A hard rejection can never wedge a repo, which is what makes this safe:
- editing `webpieces.config.json` is **always** permitted, even while the config is invalid,
- `pnpm wp-prune-unknown-config` is an **L0 cure**, so the mechanical deletion of keys no validator knows
  runs from inside the block as well.

`pnpm install` is permitted too (installer bypass), but it is **not** the cure for a validation error — the
version-drift guard denies every tool call before the validator runs, so a validation error on screen means
the pin and `node_modules` already agree.

So **"rejecting it would deadlock the consumer" is not a reason to add a fallback.** It is not true, and it
is the exact argument that licensed the fallbacks which then kept this repo's own config on dead shapes for
releases (an accepted shape is never migrated).

**Where it lives:** retirements go in `RETIRED_CONFIG_KEYS` (`packages/tooling/rules-config/src/retired-config-keys.ts`)
— the ONE place a dead key may be named — and you delete its read path in the same change.
`retired-config-keys.spec.ts` and the end-to-end loop in `load-config.spec.ts` assert every entry actually
fails the load, so re-adding a fallback turns them red.

This is about config SHAPE, and does not soften the release-ordering rule above: source and the config that
uses it still ship in separate PRs, because the running validator is a release behind.

**Corollary for instructions generally:** webpieces owns the `wp-*` workflow, and this file must POINT
AT it rather than restate it. Any path, filename or command output hand-copied into CLAUDE.md drifts
out from under us silently on the next release — a copied `review.json` path did exactly that and sent
agents writing to a file nothing reads. Name the tool; let the tool print the details.

## Finishing a Feature (CRITICAL)

**RULE: Finishing a feature MEANS posting the PR. They are the same step, not two.**

When the code is written, tests pass, and the affected build is green, your **very next action is to post the
PR** — do NOT end your turn with "want me to open a PR?" That question is already answered: **yes,
always.** Commit your work (the tooling never commits for you), then run the gated flow:

```bash
pnpm wp-start-upsert-pr        # ① 3-point update from main
pnpm wp-review-upsert-pr       # ② validates that merge, BUILDS it, extracts the diff, briefs the reviewers
                               #   → then spawn the reviewers it names and write review.json
pnpm wp-finish-upsert-pr       # ③ creates/updates the PR
```

Stage ② is where verification happens: it fails on an unresolved merge or a red build BEFORE any
reviewer is spawned, so a broken branch costs no review effort. It records the sha it verified, and
stage ③ skips its own build when HEAD has not moved — three stages, one build.

The full workflow (worktrees, conflicts, the 3-point merge) is documented in
`.webpieces/instruct-ai/webpieces.git-workflow.md`, refreshed on every `wp-*` command.

**The PR description IS the squash-commit body.** Stage ③ renders one compact string — PR link, risk,
non-green flags, a 4-sentence summary, the build-command footer — and uses it as *both* the PR
description and the `--body-file` it merges with. The full dashboard and each reviewer's output go into
the PR's 1st and 2nd comments, so they never reach `git log`.

That makes every landing route agree — the GitHub Merge button, a bare `gh pr merge`, `pnpm wp-land-pr`,
and stage ③'s own auto-merge all write identical bytes. **Nothing here is yours to configure or remember.**
It depends on two GitHub repo settings (`squash_merge_commit_title: PR_TITLE`,
`squash_merge_commit_message: PR_BODY`), and stage ③ verifies and REPAIRS them itself on every run —
see `SquashSettingsEnforcer`. Those live on GitHub's servers, not on disk, so no config key can express
them and no validator can see them; that is exactly why the tooling sets them instead of a doc asking you
to. Without repo-admin rights it prints the one `gh api` command to forward to an owner.

**Prefer `pnpm wp-land-pr` from the CLI** — it also archives the pre-squash tip and reaps the landed
worktree — but the UI button is not wrong, which is the point.

Once the PR merges, clean up. Pick the form for the tree you are in — a linked worktree has no `main` to
check out (`main is already checked out at <primary clone>`), so the two forms are not interchangeable:

- in the primary clone:
  ```bash
  pnpm wp-land-pr && pnpm wp-checkout-clean-main
  ```
- in a linked worktree — land, then run the same cleanup **from the primary clone** (`wp-cleanup`
  deliberately spares the worktree you are standing in, so it cannot reap the one you are inside):
  ```bash
  pnpm wp-land-pr
  pnpm wp-checkout-clean-main     # from the primary clone
  ```

`wp-checkout-clean-main` is one command for one intention: fetch, check out `main`, `pull --ff-only`,
`wp-cleanup`, then sweep the orphan directories an `nx g move` leaves on every clone. Do **not** hand-roll
`git checkout main && git pull origin main && pnpm wp-cleanup` instead — that is the same command minus
the sweep, which is exactly how the sweep never ran for anybody. (The raw pair is still legal git, and it
is deliberately still the L0 version-drift cure, because in an L0 block `node_modules` is the thing in
doubt and no `pnpm` bin can be relied on to load.)

`wp-cleanup` reaps **worktrees first, then branches**, and that order is the whole fix: a worktree HOLDS
its branch, so reaping the tree is what makes the branch reapable, and the branch pass then recomputes
its verdicts against the post-removal truth. Do not hand-run `git worktree prune`/`remove` or
`git branch -D` — the tool does both, in the right order, and archives what it removes.

It removes what it can PROVE is dead — a worktree whose directory is already gone, or whose branch is
dead by a merged PR (its own, or the one it snapshots); a branch that is merged or is a squash-merge
backup of a merged one — **plus every zero-commit husk**: a ref identical to `origin/main`, where the
delete costs a NAME and not a commit. A husk is spared only when somebody is provably HOLDING it: a
worktree with uncommitted or untracked files, one LOCKED by something still there (whoever the lock
reason names, or a claude agent whose pid is still running), the tree you are standing in, a detached
HEAD — each reported with that as its reason. Every removal is logged with its pre-delete SHA and a
`recover=` command that brings back both the directory and its branch. Do not stop to ask whether it is
safe to run — it is the sanctioned cleanup command, and asking is what let stale branches and worktrees
pile up in the first place.

Anything carrying UNIQUE COMMITS is never taken by default. It is printed in a numbered, classified
block — identical whether or not there is a terminal — and you act on it with a flag:

```bash
pnpm wp-cleanup --report                 # the whole classified picture, deletes nothing
pnpm wp-cleanup --delete-branches=all    # or =none, or =1,3 by the numbers just printed
pnpm wp-cleanup --delete-worktrees=1,2
pnpm wp-cleanup --interactive            # prompt even with no tty
pnpm wp-cleanup --help
```

The numbers in a `--delete-*` flag are the numbers printed on the SAME run; a number past the end of the
block stops the run rather than deleting the wrong ref. An explicit flag always beats the terminal sniff
(`isTTY` was only ever a guess about who was standing there).

**The ONLY reasons to stop before posting the PR:**
- The human explicitly said "don't open a PR yet."
- The build or tests are red.

Otherwise, stopping after a green build without posting the PR is a bug — not politeness.

## Common Mistakes to Avoid

1. ❌ Using interfaces for data structures
2. ❌ Creating anonymous object literals for configs/definitions
3. ❌ Forgetting to export classes from index.ts
4. ❌ Using `any` instead of `unknown` for generic types
5. ❌ Skipping tests for new features
6. ❌ Not documenting differences from Java version
7. ❌ Stopping at a green build and asking "want me to open a PR?" instead of posting it (see "Finishing a Feature")
8. ❌ Asking "can I clean up these merged branches?" instead of just running `pnpm wp-cleanup`
9. ❌ Keeping the old spelling of a changed surface — as `@deprecated`, as an overload, as a config fallback,
   or just left exported "so existing code compiles" (see "NO webpieces surface is released
   backwards-compatible"). Delete it; the compile error is how callers get migrated.
10. ❌ Building the whole monorepo (`pnpm run build-all`, `nx run-many` with no `-p`, `nx affected` with no
   `--base`, a bare `pnpm exec vitest run`). Run `pnpm wp-build`, or one project, or one spec file
   (see "Build Verification"). `whole-repo-build-guard` names `pnpm wp-build` in its refusal — when this
   machine has opted into it via `~/.webpieces/config.json`.
11. ❌ Hand-composing a verify chain (`format:check && webpieces:ci && test:affected` and friends), or
   adding a leg to `wp-build`. One command, one config value. Anything that must run on every build goes
   inside `commands.pr-gate.buildCommand`, so the PR gate runs it too.
