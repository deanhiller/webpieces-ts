# PR #2 — Angular DI analyzer + DI-graph label fix

> Companion to PR #1 (framework/libType tagging, done in the `webpieces-ts30` checkout).
> Implement this PR here in `webpieces-ts40` on branch `dean/wire-wp-design-visualize`.
> All paths below are within `packages/tooling/nx-webpieces-rules/src/lib/di-graph/`.

## Context

The `di-graph-generate` executor renders one DI design tree per root into `<project>/design.json` + `design.md` (viewed via `pnpm wp-design-visualize`). Today it only understands **Inversify** DI (roots on `@Controller`, walks constructor `@inject`/typed params). Two problems:

1. **It has no Angular support** — we want the injection tree rendered "from the page/root component on down".
2. **Its box/edge labels are wrong** — boxes show the bound implementation detail (`buildConfigFromEnv(...)`, `logger`) and edges show the raw token expression (`FIRESTORE_TYPES.Logger`), instead of the **declared class/interface of each constructor param** (`FirestoreConfig`, `FsLogger`).

**v1 scope (per user): only `angular` and `express` projects generate a DI design graph.** react/all projects are skipped for now, including the current "controller-less library top-of-DAG" behavior (deferred). Analyzer selection is driven by the project's `framework` nx tag from PR #1.

---

## B0. Fix the existing label bug (applies to BOTH Inversify + Angular output)

Observed in a consumer monorepo's `design-helper-portal-svr.html`: for
```ts
constructor(
  @inject(FIRESTORE_TYPES.FirestoreConfig) private firestoreConfig: FirestoreConfig,
  @inject(FIRESTORE_TYPES.Logger)          private logger: FsLogger,
) {}
```
boxes render as `buildConfigFromEnv(moduleOptions.defaultProjectId)` and `logger`, and edges as `FIRESTORE_TYPES.FirestoreConfig` / `FIRESTORE_TYPES.Logger`. They **should** be one box per constructor param labeled with the declared class/interface: `FirestoreConfig` and `FsLogger`.

Root cause (`analyzer.ts`): `walkParam` already computes `paramType`/`paramName` (`analyzer.ts:235`) but `walkTokenParam` → `bindingTarget` → `leafNode` labels leaf boxes from `binding.valueText`/`tokenDisplay` (`analyzer.ts:190-201`) and edges from `token.display` (`262`, `268`). The declared param type is dropped.

Fix (behavior-preserving for resolved-class nodes, corrective for constant/dynamic/unresolved leaves):
- Thread `paramType` (and `paramName`) into `bindingTarget`/`leafNode`/`unresolvedNode`. For **constant / dynamic / unresolved** leaf nodes, set the box `className` = `paramType` (the declared interface/class, e.g. `FsLogger`, `FirestoreConfig`) instead of `valueText`/`tokenDisplay`. Keep `valueText` in `design.json` as a secondary detail field if useful.
- Edge labels: render `paramName` (e.g. `logger`, `firestoreConfig`) rather than the raw token expression `FIRESTORE_TYPES.X` in `dot.ts:72-73` and the mermaid equivalent. Keep `token`/`tokenKey` in the serialized `DiEdge` for tooling — just don't render the token as the human label.
- `class`/`type` nodes are already correct (labeled from the resolved class name); no change.

Impact: this changes committed `design.json`/`design.md` for every project. The `validate-di-graph-unchanged` gate requires regenerating & committing them here; downstream consumer repos regenerate after upgrading the published `@webpieces` version. Call this out in the PR.

Files: `analyzer.ts`, `dot.ts`, `mermaid.ts`, `serializer.ts` (if the `DiEdge`/`DiNode` shape gains a field), `model.ts`.

---

## B1. Reuse map (front-half is the only new work)

Reused unchanged: `model.ts`, `serializer.ts` (`toDesignJson`), `mermaid.ts`, `dot.ts`, `assignLevels()`, `program.ts` (`createProjectProgram` already prefers `tsconfig.app.json`, which `angular-site` has), `token-resolver.ts` (`resolveTokenKey`, `classTokenKey`, `resolveClassDeclaration`). Angular tokens are almost always **class references** (`inject(SaveApi)`, `{provide: ClientConfig}`), which `classTokenKey` handles.

## B2. Roots — `angular-roots.ts` (new)

`findAngularRoots(program, checker, workspaceRoot, projectRoot)`:
- **Bootstrap root**: find `bootstrapApplication(X, cfg)` (`apps/app-example/angular-site/src/main.ts`); resolve `arguments[0]` → root `@Component`; capture `arguments[1]` (the `ApplicationConfig` expr) for the provider table.
- **Route roots**: locate the `Routes`-typed array (and any array passed to `provideRouter(...)`). For each object literal: `{ component: X }` → resolve; `{ loadComponent: () => import('./x').then(m => m.X) }` → resolve `m.X` (risk #1); recurse `children`. Empty today (`app.routes.ts`) but handle structurally.
- Each root becomes its **own `DiDesign`** (one tree per root, like one-design-per-controller). Dedup by class decl; sort by class name.

## B3. Provider table — `angular-providers.ts` (new)

`collectAngularProviders(...)` → reuse `BindingTable`/`Binding`, mapping Angular onto existing `Binding` fields:
- `useClass: Impl` / bare class provider → `to`/`toSelf`-style binding (`implClass`).
- `useValue: expr` → `toConstantValue` leaf.
- `useFactory: fn, deps: [A,B]` → `toDynamicValue` leaf **plus** record `deps[]` so the walker emits edges to each dep. Add one additive field `factoryDeps?: TokenRef[]` to `Binding` in `model.ts`.
- `useExisting: Other` → alias; resolve to target impl at walk time.
- `multi: true` → multiple bindings per token (existing fan-out handles it).

Scopes (precedence): `ApplicationConfig.providers` (from bootstrap `cfg`, followed to `app.config.ts`), `@Component({providers:[...]})`, `@Injectable({providedIn:'root'|'platform'|'any'})` self-registration (like `collectDecoratorBindings` for `@provideSingleton`; e.g. `EnvironmentConfig`), and bare `@Injectable` classes injected without an explicit provider (walk-time fallback). v1 uses a flat global table (component-scoped shadowing is an accepted approximation — document it).

**Skip framework-internal provider functions** (`provideRouter`, `provideZoneChangeDetection`, other `provideXxx()`): no leaves; only recurse into `provideRouter(routes)`'s `routes` arg for route roots.

## B4. Walk a component/service — `angular-analyzer.ts` (new)

`buildAngularDiGraph(...)`. Refactor `DiDesignBuilder` in `analyzer.ts` to expose node/leaf/unresolved/id/`assignLevels` via `protected` members + an overridable `collectInjections(cls): Injection[]` hook. Rename current concrete impl `InversifyDesignBuilder`; add `AngularDesignBuilder`. Keeps Inversify output byte-identical (the `validate-di-graph-unchanged` gate across all existing projects is the safety net).

Angular injection sites per class:
1. **Constructor params** — reuse existing param walk; also recognize `@Inject(TOKEN)` (capital I) and `@Optional/@Self/@SkipSelf/@Host`.
2. **Field initializers calling `inject()`** — NEW: iterate `cls.members` for `PropertyDeclaration` whose initializer is an `inject(TOKEN)` call (the pattern `AppComponent` uses: `saveApi`, `publicApi`, `envConfig`). `arguments[0]` = token → resolve + lookup + recurse. Param name = field name; param type = declared type (so B0's box-labels-are-types fix applies here too).

Per resolved token: recurse into `implClass`; `useValue` → `constant` leaf; `useFactory` → `dynamic` leaf **and** emit edges to each `factoryDeps` token (so `ClientConfig`'s factory shows edges to `EnvironmentConfig` + `MutableContextStore`); unresolved → `unresolved` node. Never fail generation.

## B5. Node-kind mapping

Add `'component'` to `DiNodeKind` in `model.ts` for Angular roots (clearer than overloading `'controller'`; ~4 trivial additive edits in `mermaid.ts`/`dot.ts` KIND_COLORS + root styling). `useValue→constant`, `useFactory→dynamic`, plain service→`class`, unresolved→`unresolved` map directly.

## B6. Executor branching — `analyzer-strategy.ts` (new) + `executor.ts`

- `DiAnalyzer` interface `analyzeProject(program, workspaceRoot, projectRoot, projectName): DiGraph`; `InversifyAnalyzer` (express) wraps existing `buildDiGraph`, `AngularAnalyzer` wraps `buildAngularDiGraph`.
- Selection driven by the project's **`framework` tag** (PR #1): `express` → `InversifyAnalyzer` (roots on `@Controller`), `angular` → `AngularAnalyzer`, anything else → empty graph / skip. Cheap marker pre-scan is only a corroborating fallback when the tag is absent: **angular** if `@Component(`/`bootstrapApplication`; **express** if `@Controller(`.
- Add Angular markers to `DI_MARKERS` in `executor.ts` so the pre-scan doesn't short-circuit `angular-site` to empty. Swap the direct `buildDiGraph` call for select→`analyze`. `di-graph-targets.ts`, `validate-di-graph-unchanged`, and the inference plugin need no change.

## B7. Edge cases
`forwardRef(() => X)` → unwrap; `@Optional` → existing optional handling; `@Self/@SkipSelf/@Host` → record edge, ignore scope nuance (v1); `useExisting` → resolve through to target impl; `inject()` inside methods (not fields) → out of scope for v1 (document as a known gap).

## B8. Risks
1. **`loadComponent` dynamic-import resolution** (highest) — `checker.getSymbolAtLocation` on `m.X` inside `.then` may not resolve; fall back to an `unresolved` root and/or string-parse `import('./path')` + member. Spike first.
2. **`useFactory` inline `new`** — v1 draws only the declared `deps:[...]` edges (the true DI boundary), not the inline `new HeaderRegistry(...)` graph. Document as intended.
3. **Cross-package class identity** — `inject(SaveApi)` and `{provide: SaveApi}` must resolve to the same `ts.ClassDeclaration`; verify `tsconfig.app.json` path maps don't split one side to a `.d.ts`. Same assumption the Inversify analyzer relies on.
4. **Builder refactor blast radius** — must keep Inversify output byte-identical; the `validate-di-graph-unchanged` gate catches regressions.

## B9. Verify
```bash
pnpm nx run angular-site:di-graph-generate      # angular-site/design.json + design.md
pnpm wp-design-visualize angular-site           # AppComponent tree: SaveApi, PublicApi, EnvironmentConfig; ClientConfig factory → EnvironmentConfig + MutableContextStore
pnpm nx run <an-inversify-project>:di-graph-generate   # confirm B0: boxes show declared types (FirestoreConfig, FsLogger), edges show param names
pnpm nx run-many --target=di-graph-generate           # regenerate all; commit updated design.* (validate-di-graph-unchanged gate)
pnpm run build-all
```
Add unit tests for `angular-roots` (bootstrap + route resolution), `angular-providers` (useClass/useValue/useFactory+deps/@Injectable), the field-`inject()` walk, and a regression test locking the B0 param-type labeling.
