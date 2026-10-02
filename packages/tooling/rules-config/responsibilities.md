# Responsibilities — rules-config

Shared config/schema layer: loads and validates webpieces.config.json, defines every rule's typed config, mode unions, defaults, path-exclusion and diff-scope helpers, plus PR-gate and main-sync state. Single source of truth consumed by ai-hook-rules, code-rules, and nx-webpieces-rules.

## In Scope

- Loading, validating, and locating `webpieces.config.json` (`loadAndValidate`, `findConfigFile`, `validateWebpiecesConfig`).
- Schema field types (`FieldDef`): scalars, `string[]`, and an `object[]` (non-empty, or possibly empty
  via `FieldDef.objects`) whose elements are validated against their own schema
  (`required-type-suffix`'s `entries`, #1037; `api-lib-dependencies`' `apiClients`, #1064).
- The five tag-truth rule schemas (#1064, `tag-truth-configs.ts`): `api-lib-dependencies`, `api-lib-path`,
  `framework-folder` (graph rules, run by nx-webpieces-rules) and `framework-tsconfig`,
  `framework-packages` (project rules, run by code-rules). No defaults; the recommended values are SEEDED
  and documented in `.claude/rules/framework-tags.md`.
- Typed per-rule config classes (`*Config`), mode unions (`METHOD_LIMIT_MODES`, `ON_OFF_MODES`, etc.) and `defaultRules` — the canonical schema shared by all consumers.
- The built-in `ensure-we-are-secure` schema, seeded in `MODIFIED_PROJECTS` mode with only the
  universal branch/epoch turn-offs (no annotation-level security bypass).
- Cross-cutting helpers reused by both edit-time and build-time engines: path exclusion, diff/changed-line scoping, disable-directive constants, template loading.
- Shared error types (`RuleFailError`, `InformAiError`), section/hook-guard metadata, PR-gate config, main-sync status/lock state, match-rule and controller-naming config.

## Out of Scope

- Actually running rules at edit time (belongs in ai-hook-rules) or at build time (belongs in code-rules).
- Claude Code / openclaw hook wiring and adapters (ai-hook-rules).
- CLI gate execution / CI orchestration (code-rules).
- Nx target wiring (nx-webpieces-rules).

## Notes (optional)

Pure config + schema + shared utilities with no execution engine — this is why both the edit-time and build-time engines depend on it, never the reverse.

**webpieces.config.json is never released backwards-compatible.** When a key moves, is renamed, or is deleted, the loader REJECTS the old shape with an error naming the destination — no fallback, no alias applied before validation, no "still accepted until every consumer migrates". Every reader of this file is a coding agent: it is handed the exact edit and applies it in one pass, so the upgrade is seamless without a compatibility layer. Retirements live in exactly one place, `RETIRED_CONFIG_KEYS` in `src/retired-config-keys.ts`, and `retired-config-keys.spec.ts` plus the end-to-end loop in `load-config.spec.ts` assert each one actually fails the load.

Do not add a fallback because rejection "would deadlock the consumer" — it cannot. Editing `webpieces.config.json` is permitted even while it is invalid, and `pnpm install` is always permitted, so a rejected config is always repairable in place.

Note this is about config SHAPE, not release ordering: published validators still lag local source by a release, so a new key and the config that uses it must ship in separate PRs (see `.claude/rules/published-vs-local-source.md`).

## Shared mechanics extraction (#1072)

Generic `AtomicFile`, `InformAiError`, `DotWebpieces`, state-path constants, state-dir migration, and harness config-directory resolution now live in `@webpieces/tooling-common`. The eager-load-free `toError` leaf is `@webpieces/tooling-common/to-error`. Branch identity, main-sync files/status/cache, merged-branch classification, worktree discovery/locks, branch reaping/archiving/mutation logs, and review-identity stamps now live in `@webpieces/repo-workflow-core`. Import these APIs from their owning package; this package does not re-export them.

Review JSON, provenance, checklists, gate tokens, build ledgers, home configuration, and orphan/tmp sweeps retain their existing ownership. Cross-package integration specifications remain here when they exercise config/PR consumers as well as shared mechanics.
