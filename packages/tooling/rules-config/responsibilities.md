# Responsibilities — rules-config

Shared config/schema layer: loads and validates webpieces.config.json, defines every rule's typed config, mode unions, defaults, path-exclusion and diff-scope helpers, plus PR-gate and main-sync state. Single source of truth consumed by ai-hook-rules, code-rules, and nx-webpieces-rules.

## In Scope

- Loading, validating, and locating `webpieces.config.json` (`loadAndValidate`, `findConfigFile`, `validateWebpiecesConfig`).
- Typed per-rule config classes (`*Config`), mode unions (`METHOD_LIMIT_MODES`, `ON_OFF_MODES`, etc.) and `defaultRules` — the canonical schema shared by all consumers.
- Cross-cutting helpers reused by both edit-time and build-time engines: path exclusion, diff/changed-line scoping, disable-directive constants, template loading.
- Shared error types (`RuleFailError`, `InformAiError`), section/hook-guard metadata, PR-gate config, main-sync status/lock state, match-rule and controller-naming config.

## Out of Scope

- Actually running rules at edit time (belongs in ai-hook-rules) or at build time (belongs in code-rules).
- Claude Code / openclaw hook wiring and adapters (ai-hook-rules).
- CLI gate execution / CI orchestration (code-rules).
- Nx target wiring (nx-webpieces-rules).

## Notes (optional)

Pure config + schema + shared utilities with no execution engine — this is why both the edit-time and build-time engines depend on it, never the reverse. Keep mode-token changes here backward-compatible since published validators lag one release.
