# Responsibilities — tooling-common

Generic file operations, error normalization, harness config paths, and repository state path primitives. No config loader, rule policy, or workflow classification.

One exception, deliberate: the SYNTAX-ONLY source analyzers that must give the identical verdict in both
runners — the Write/Edit guard (`@webpieces/ai-hook-rules`) and the build gate (`@webpieces/code-rules`).
`SourceSyntax` (`./source-syntax`) is the one TypeScript parse, and `CatchPropagationAnalyzer`
(`./catch-propagation`, rule `catch-must-propagate`, #1313) is the first analyzer on it. They live here,
below both packs, so one module parses and judges for both; each pack keeps the rule's config, scoping and
rendering. Each sits behind its own subpath so the root entry never loads `typescript`.
