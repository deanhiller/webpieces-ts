# Runtime wiring producer rollout evidence

Issue [#1106](https://github.com/deanhiller/webpieces-ts/issues/1106) is delivered in staged producer changes:
[tooling PR #1124](https://github.com/deanhiller/webpieces-ts/pull/1124), published as **0.4.855**,
then [integration fixes #1128](https://github.com/deanhiller/webpieces-ts/pull/1128), followed by
this installed-tooling adoption, example migration and final reviewed design regeneration.
Downstream delivery is explicitly tracked in [#1122](https://github.com/deanhiller/webpieces-ts/issues/1122);
saved consumer graphs are rendering evidence, not evidence that consumer source has migrated.

## Changed producer paths

Each of `apps/app-example/client-server`, `legacy-server`, `server2`, and `angular-site` now owns
`src/wiring.ts` and an explicitly reviewed `runtime-deps.json`, selected through its `webpieces` tag
in `project.json`. Node AppModules delegates its binding/routing getters to the same ServerWiring
plan; Angular `src/app/app.config.ts` installs its BrowserWiring providers. The former standalone
`AppRoutes.ts`, `LegacyRoutes.ts`, and `Server2Routes.ts` registrations moved into owner wiring.
Ordinary bindings remain in `src/modules/InversifyModule.ts`; RPC bindings moved into wiring while
retaining their injection tokens and lazy factory resolution. Legacy adds `tsconfig.app.json` and
an explicit configured build output, so its declaration proof is a build prerequisite too.

`pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `.webpieces/rules.lock.json` consume installed 0.4.857.
The reviewed architecture/dependency/runtime snapshots and producer design artifacts are regenerated
with that installed release. The initial 0.4.855 attempt exposed two integration gaps: DI diagrams
lost the helper singleton API boundaries, and API validation checked hosts before loading service
identities. PR #1128 fixes both before this migration. Five focused DI fixtures prove aliases,
singleton boundaries, typed tokens and unrelated-method exclusion; analysis over the four real
migrated apps resolves all tokens. Generated `**/design.html` artifacts join the existing generated
architecture HTML exemption in `.webpieces/rules/code-rules.json`; Angular source styling remains
enforced. See [runtime-wiring.md](runtime-wiring.md) for schema, supported static composition,
explicit approval, legacy migration and release sequencing.

## Behavioral and graph evidence

The focused server integration/helper run passed **32 tests in six files**: real client-server
routes, shared-secret/JWT/OIDC behavior, request context, recording, legacy overrides, lazy binding,
and two distinct destinations for one API. Existing mock tokens still override production bindings
before any client factory resolves.

The old producer snapshot had four runtime edges. Three remain:

- Angular → client-server: PublicApi and SaveApi.
- client-server → server2: Server2Api.
- legacy-server → server2: Server2Api.

The removed Angular → legacy-server PublicApi/SaveApi edge was a false fan-out: the old scanner could
not recover the destination from its injected ClientConfig and drew both implementations. The source
already registered client-server against EnvironmentConfig's base URL; explicit targets now preserve
that actual selection. Legacy's explicit host identity does not change its HTTP behavior. No producer
API contract, queue, or trigger was removed.

The recovered tooling run passed its authoritative affected-project gate and GitHub CI. Its final
compatibility review required forbidding structural implements-plus-target facts; the author fixed
that and the gate compiled the negative assertion. That final fix is visibly author-remediated, with
no third review round. Seven real-Chromium filtering regressions pass, including redraw/render and
binding-failure recovery, queues, external nodes, and lock persistence. Compact detail unit coverage
includes 0/1/2/3/10 API groups, two targets, qualified identity and hidden external uses.

Fresh local-file Chromium runs over both saved monorepo3 and monorepo6 wide snapshots pass at 1280
and 1920 pixels: 24 rendered nodes, five API dropdowns, 100% initial readable scale, Fit, 125% zoom,
readable reset, keyboard open and Escape dismissal. Fit is 70% at 1280 and 100% at 1920. The consumer
snapshots were read before producer migration and are preserved as baselines; they were not regenerated
or edited by this task.

## Measured producer proof and graph cost

These are source-verification/assembly measurements, not whole-workspace build benchmarks. First and
repeat extraction samples run sequentially in one initialized Node process; “first” does not claim an
empty operating-system file cache. Each project verification creates exactly one TypeScript program.
Read counts exclude node_modules; source-file totals include the compiler's transitive declarations.

| Project | First verification | Repeat verification | Program source files | File read calls |
|---|---:|---:|---:|---:|
| client-server | 409 ms | 210 ms | 551 | 204 |
| legacy-server | 236 ms | 215 ms | 550 | 203 |
| server2 | 187 ms | 179 ms | 501 | 154 |
| angular-site | 214 ms | 172 ms | 390 | 131 |

The sequential verification process's cumulative peak RSS rises from 270704 to 671872 KiB; that is
not an isolated per-project peak. In a separate graph process, first approved assembly plus runtime
derivation takes **7.81 ms**, repeat **0.96 ms**, with **zero compiler programs and zero source reads**;
cumulative peak RSS is 173264/173936 KiB. Both produce five service records and three edges (the
non-runtime test application is retained in JSON and hidden from the drawing).

The actual installed Nx proof's warm run takes 865 ms and is a cache hit. Temporarily changing only
the client-server target to changed-target invalidates it: 2373 ms, cache miss, failure with approval
and candidate paths plus the target diff. The approved file stays byte-identical. Source is restored
in a finally block; the restored proof passes from cache in 1037 ms. Candidates are build outputs;
approvals are never overwritten by verification.

## Downstream completion boundary

AuthStoreApi deployment pairs, conditional shared-library modules, erased vendor interfaces, real
consumer queues/callers, full consumer cold/warm/affected build measurements, and consumer source/graph
parity must be exercised during #1122. Producer fixtures and baseline rendering do not satisfy those
consumer acceptance criteria. That issue carries the required migration, behavioral, performance and
reviewed-artifact acceptance criteria, and must remain open until its downstream PR lands.

## Tooling implementation inventory

The release PRs contain the implementation and their exact changed-file diffs. Principal public
surfaces and integration paths are:

| Responsibility | Paths |
|---|---|
| Typed targets, tokens, policy and external facts | `packages/http/http-client-core/src/ClientToken.ts`, `RpcTarget.ts`, `WiringPolicy.ts`, `ExternalContractUse.ts` and barrel exports |
| Node lazy RPC and task bindings | `packages/http/http-client-node/src/RuntimeClients.ts`, `packages/cloud/cloudtasks-client/src/RuntimeTaskClients.ts` and their specs |
| Browser providers and plan | `packages/http/http-client-browser/src/BrowserWiring.ts`, `RpcClientProvider.ts` and provider specs |
| Separate Node route/DI plan | `packages/http/http-routing/src/ServerWiring.ts` and compile assertions |
| Approved schema, extraction and assembly | `packages/tooling/nx-webpieces-rules/src/lib/runtime-wiring/` (`declaration.ts`, `codec.ts`, `source-extractor.ts`, `source-values.ts`, `verification.ts`, `assembler.ts`, `approved-graph.ts` and tests) |
| Nx source proof | `packages/tooling/nx-webpieces-rules/src/runtime-wiring-targets.ts`, `src/executors/runtime-wiring-check/` and generator/architecture/API validation consumers |
| Readable graphs and complete details | `packages/tooling/nx-webpieces-rules/src/lib/graph-navigation.ts`, `runtime-details.ts`, `runtime-visualizer.ts`, `runtime-html-page.ts`, `runtime-graph-model.ts`, client scripts and browser/detail tests |
| DI helper integration and host validation | `packages/tooling/nx-webpieces-rules/src/lib/di-graph/runtime-client-bindings.ts`, `bindings.ts`, `angular-providers.ts`, `token-resolver.ts`, helper tests and `src/executors/validate-api-relations/executor.ts` |

Release #1128 passed its affected local gate, all four required checklists and GitHub build/token CI.
Its initial publication attempt conflicted with the concurrent #1125 version upgrade; the sanctioned
merge retained main's managed fixture cleanup and the combined gate and CI passed. This adoption
uses the published 0.4.857 package rather than substituting source generators into installed tooling.
