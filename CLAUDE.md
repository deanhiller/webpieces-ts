# Claude Code Guidelines for webpieces-ts

This document contains guidelines and patterns for Claude Code when working on the webpieces-ts codebase.

**This file is an INDEX.** It is loaded into every session and every reviewer subagent, so it carries
only the rules you must obey without being prompted to go and read something — the code-style
principles, the one-line build rule, the one-line finish-the-feature rule, and the list of failure
modes. Everything with a long rationale, a matrix, an incident narrative or a worked example lives in a
topic file under `.claude/rules/`, moved there **verbatim**. Read the row that matches what you are
about to do; skip the rest.

| Read this | When |
|---|---|
| `.claude/rules/build-verification.md` | you are about to run a build, a build failed and you need the log, a build was REFUSED for contention, or you are tempted to hand-compose a verify chain |
| `.claude/rules/tickets.md` | you are starting any change (does it have a GitHub issue yet?) or writing the PR body (does it carry `Fixes #NNN`?) |
| `.claude/rules/finishing-a-feature.md` | the code is written and you are posting the PR, landing one, or cleaning up branches and worktrees afterwards |
| `.claude/rules/no-backwards-compat.md` | your diff changes ANY surface — a decorator, an `*Api.ts`, a `src/index.ts` barrel, anything under `packages/**`, or a `webpieces.config.json` key |
| `.claude/rules/experiments.md` | your diff touches an `experimental.*` flag, its read path, its default, or the policy prose about experiments |
| `.claude/rules/published-vs-local-source.md` | you change `packages/tooling/**`, a validator rejects a config key, a guard/executor does not seem to see your change, or you are in a linked worktree |
| `.claude/rules/packaging-and-bins.md` | you touch a `package.json` `bin` / `publishConfig`, the publish script, `pnpm-workspace.yaml`'s catalog, or a `workspace:` dep between `packages/tooling/*` |
| `.claude/rules/framework-patterns.md` | you are writing a filter, a controller, a `Routes` class, or a test against the server, or you need the request-path architecture overview |
| `.claude/rules/decorator-object-literal-carve-out.md` | you are about to write an object literal as a DECORATOR argument, or you are reviewing one |

`.claude/review/*.md` are the REVIEWER instruction docs — you read one only when
`pnpm wp-review-upsert-pr` names it for a checklist you were spawned for.

## Core Principles

The numbering is the original numbering: principles 2 (Filter Chain Architecture), 6 (Decorators),
7 (Testing) and 8 (Documentation) moved to `.claude/rules/framework-patterns.md`, and the carve-out
under 3 moved to `.claude/rules/decorator-object-literal-carve-out.md`.

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

## Build Verification (CRITICAL)

**RULE: verify with `pnpm wp-build`. Never build the whole monorepo, and never hand-compose a verify
chain of your own.** The build's output goes to a log FILE, not to your terminal: read the log at the
absolute `FullLog :` path THIS run printed, and never re-run the build to see a different slice of it.

Everything else — where the log lands, the machine-wide contention ledger and its refusal, the tighter
inner loops, `whole-repo-build-guard`, and why `affected` still covers the workspace-global validators —
is in **`.claude/rules/build-verification.md`**.

**A green build is NOT the finish line.** When the feature is actually complete, proceed to "Finishing a
Feature" below — do not stop at a green build.

## Finishing a Feature (CRITICAL)

**RULE: Finishing a feature MEANS posting the PR. They are the same step, not two.**

Commit your work (the tooling never commits for you), then run the gated flow —
`pnpm wp-start-upsert-pr`, `pnpm wp-review-upsert-pr`, `pnpm wp-finish-upsert-pr`, in that order —
obeying what each command prints on THIS run. What each stage does, and what to spawn between ② and ③,
is in `.claude/rules/finishing-a-feature.md`.

**The ONLY reasons to stop before posting the PR:**
- The human explicitly said "don't open a PR yet."
- The build or tests are red.

Otherwise, stopping after a green build without posting the PR is a bug — not politeness.

The landing routes, the squash-body contract, and the cleanup rules (`pnpm wp-land-pr`,
`pnpm wp-sync-main`, `pnpm wp-cleanup` and its flags) are in
**`.claude/rules/finishing-a-feature.md`**.

## Common Mistakes to Avoid

1. ❌ Using interfaces for data structures
2. ❌ Creating anonymous object literals for configs/definitions
3. ❌ Forgetting to export classes from index.ts
4. ❌ Using `any` instead of `unknown` for generic types
5. ❌ Skipping tests for new features
6. ❌ Not documenting differences from Java version
7. ❌ Stopping at a green build and asking "want me to open a PR?" instead of posting it (see
   `.claude/rules/finishing-a-feature.md`)
8. ❌ Asking "can I clean up these merged branches?" instead of just running `pnpm wp-cleanup`
9. ❌ Keeping the old spelling of a changed surface — as `@deprecated`, as an overload, as a config fallback,
   or just left exported "so existing code compiles" (see
   `.claude/rules/no-backwards-compat.md`). Delete it; the compile error is how callers get migrated.
10. ❌ Building the whole monorepo (`pnpm run build-all`, `nx run-many` with no `-p`, `nx affected` with no
   `--base`, a bare `pnpm exec vitest run`). Run `pnpm wp-build`, or one project, or one spec file
   (see `.claude/rules/build-verification.md`). `whole-repo-build-guard` names `pnpm wp-build` in its
   refusal — when this machine has opted into it via `~/.webpieces/config.json`.
11. ❌ Hand-composing a verify chain (`format:check && webpieces:ci && test:affected` and friends), or
   adding a leg to `wp-build`. One command, one config value. Anything that must run on every build goes
   inside `commands.pr-gate.buildCommand`, so the PR gate runs it too.
