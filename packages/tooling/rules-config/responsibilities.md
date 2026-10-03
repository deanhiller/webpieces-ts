# Responsibilities — rules-config

Shared tooling configuration: validates webpieces.config.json, discovers owner-provided rule schemas, supplies diagnostics, path and diff scoping, and owns PR-gate review state.

## In Scope

- Shared hook configuration diagnostics, fault vocabulary and best-effort diagnostic template pointers.

- Loading, validating, and locating `webpieces.config.json` (`loadAndValidate`, `findConfigFile`, `validateWebpiecesConfig`).
- Generic owner/contributor registry and explicit client pack discovery. The SDK supplies pure field/value contracts;
  each execution owner supplies its concrete schemas, optional tuning, reviewed seeds, section metadata, and migrations.
- Required settings are validated from the repository's explicit values. Seeds are file-writing advice;
  optional tuning is merged only into `ResolvedConfig`, preserving the raw `rulesConfig` bag.
- Cross-cutting helpers reused by both edit-time and build-time engines: path exclusion, diff/changed-line scoping, disable-directive constants, template loading.
- Structured rule failures (`RuleFailError`), section/hook-guard metadata, PR-gate config and review state, match-rule and controller-naming config.

## Out of Scope

- Actually running rules at edit time (belongs in ai-hook-rules) or at build time (belongs in code-rules).
- Harness normalization and protocol execution (hook-runtime), workflow hook installation (agent-workflow-rules), and OpenClaw composition (the umbrella package).
- CLI gate execution / CI orchestration (code-rules).
- Nx target wiring (nx-webpieces-rules).
- Generic errors and state-path utilities (tooling-common); main-sync and worktree status/locks (repo-workflow-core).

## Notes (optional)

Generic configuration validation + shared utilities with no execution engine — this is why both the edit-time and build-time engines depend on it, never the reverse.

**webpieces.config.json is never released backwards-compatible.** When a key moves, is renamed, or is deleted, the loader REJECTS the old shape with an error naming the destination — no fallback, no alias applied before validation, no "still accepted until every consumer migrates". Every reader of this file is a coding agent: it is handed the exact edit and applies it in one pass, so the upgrade is seamless without a compatibility layer. Framework shape retirements live in `src/retired-config-keys.ts`; rule and field retirements live in their owning pack manifests, and `retired-config-keys.spec.ts` plus the end-to-end loop in `load-config.spec.ts` assert each one actually fails the load.

Do not add a fallback because rejection "would deadlock the consumer" — it cannot. Editing `webpieces.config.json` is permitted even while it is invalid, and `pnpm install` is always permitted, so a rejected config is always repairable in place.

Note this is about config SHAPE, not release ordering: published validators still lag local source by a release, so a new key and the config that uses it must ship in separate PRs (see `.claude/rules/published-vs-local-source.md`).

## Shared mechanics extraction (#1072)

Generic `AtomicFile`, `InformAiError`, `DotWebpieces`, state-path constants, state-dir migration, and harness config-directory resolution now live in `@webpieces/tooling-common`. The eager-load-free `toError` leaf is `@webpieces/tooling-common/to-error`. Branch identity, main-sync files/status/cache, merged-branch classification, worktree discovery/locks, branch reaping/archiving/mutation logs, and review-identity stamps now live in `@webpieces/repo-workflow-core`. Import these APIs from their owning package; this package does not re-export them.

Review JSON, provenance, checklists, gate tokens, build ledgers, home configuration, and orphan/tmp sweeps retain their existing ownership. Cross-package integration specifications remain here when they exercise config/PR consumers as well as shared mechanics.

## Rule ownership (#1077)

`RULE_SCHEMAS`, the central `defaultRules`/seed maps, the concrete typed config aggregator, and the
three-ID workflow section list are removed. `RulePackRegistry` projects metadata from selected manifests;
`rules-config` has no static imports of concrete owners. Shared scope vocabulary belongs to the pure SDK.

During this child, the client explicitly selects the four existing flat-config owners through
`package.json` → `webpieces.rulePacks`. Lint manifests retain their four lint-only policies for discovery;
the following #1078 supplies per-pack config paths and commits the complete five-pack lock/catalog.
Engine-local implementation tables remain until that final application-boundary step. In particular,
Code still imports Nx adapters; this child does not claim complete Code/Nx build isolation.
