# Responsibilities — tooling-common

Generic file operations, error normalization, harness config paths, and repository state path primitives. No config loader, rule policy, or workflow classification.

One exception, deliberate: the SYNTAX-ONLY source analyzers that must give the identical verdict in both
runners — the Write/Edit guard (`@webpieces/ai-hook-rules`) and the build gate (`@webpieces/code-rules`).
`SourceSyntax` (`./source-syntax`) is the one TypeScript parse, and `CatchPropagationAnalyzer`
(`./catch-propagation`, rule `catch-must-propagate`, #1313) is the first analyzer on it. They live here,
below both packs, so one module parses and judges for both; each pack keeps the rule's config, scoping and
rendering. `SiteDisables` (`./source-syntax`) resolves one rule's per-site disables and their written reasons for
the same analyzers. Each sits behind its own subpath so the root entry never loads `typescript`;
`TypeScriptRequire` (root entry) loads a repo's own `.ts` rule-pack module and requires `typescript` only
when it transpiles one.

The PROCESS EDGES (#1381) live here too, because every tooling package starts programs and none may do it
directly: `GitProcessApi` (git) and `NativeProcessApi` (any other program, and a shell command whose
output goes to a log file), each an abstract class taking and returning data classes (`GitResultDto`,
`ProcessResultDto`, `ShellTerminationDto`), with the production `GitProcessClient` / `NativeProcessClient`
the only callers of `child_process`, and `ProcessBindings` to register them. A non-zero
exit, a kill, and a program that could not start are all RESULTS, never throws. The clients' own
real-process tests (in `@webpieces/tooling-testkit`, which owns reaped scratch directories) are the only
specs that start processes for them.
