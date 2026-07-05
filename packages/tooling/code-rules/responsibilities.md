# Responsibilities — code-rules

Build-time code validation gate. Standalone (no Nx dependency) CLI that validates new and modified code against the shared rule set over a git diff, enforcing method/file limits, return types, no-any, DI-token, exception, controller-naming and related rules in CI.

## In Scope

- Build/CI-time validators run over changed files/methods (`validate-new-methods`, `validate-modified-methods`, `validate-modified-files`, per-rule `validate-*`).
- Diff-scoped enforcement: only new/modified code is gated, using rules-config diff-scope helpers.
- CLI entry points and orchestration: `wp-validate-code` and the `wp-ci` gate runner, reporting (`rule-reporter`), mode resolution.
- Standalone `CodeValidator` executor consumable without the Nx toolchain.

## Out of Scope

- Config schema, typed `*Config` classes, mode unions, defaults, and config loading (rules-config).
- Edit-time PreToolUse/hook interception and fix-hint UX for AI agents (ai-hook-rules).
- Nx executor/target wiring (nx-webpieces-rules).

## Notes (optional)

Runs at build/CI time as a gate on the committed diff — the after-the-fact counterpart to ai-hook-rules' edit-time enforcement, both drawing rule config from rules-config. Dist bins load the PUBLISHED rules-config from node_modules, so new shared symbols need co-release.
