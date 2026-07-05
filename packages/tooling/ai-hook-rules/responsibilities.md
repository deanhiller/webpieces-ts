# Responsibilities — ai-hook-rules

Edit-time validation engine for AI coding agents. Intercepts proposed file writes/edits (and Bash git/PR guards) before they land via Claude Code PreToolUse and openclaw before_tool_call adapters, running configurable rules and rejecting bad output with educational fix hints.

## In Scope

- Write-time rule engine: `Rule`/`RuleGroup` model, scope-specific bases (`EditRuleBase`, `FileRuleBase`, `BashRuleBase`), runner, report/fix-hint formatting.
- Built-in edit-time rule implementations (no-any, max-file-lines, no-destructure, require-return-type, controller-naming, DI-token, exception guards, etc.).
- Harness adapters and hook binaries: Claude Code `PreToolUse` (`wp-ai-rules-hook`, `wp-ai-guards-hook`) and openclaw plugin; setup/install CLIs (`wp-setup-ai-hooks`).
- Git/PR/branch guards fired on Bash and file edits (`hookGuards` section).

## Out of Scope

- Config schema, mode unions, defaults, and `webpieces.config.json` loading (rules-config).
- Build-time / CI gate validation over the committed diff (code-rules).
- Nx target registration (nx-webpieces-rules).

## Notes (optional)

Runs pre-commit at edit time so the AI fixes its own output before a build ever runs; each built-in rule is constructed from its typed `*Config` in rules-config. Live hooks execute the PUBLISHED release from node_modules, not local source.
