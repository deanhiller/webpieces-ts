# Responsibilities — ai-hook-rules

Source edit validation for AI coding agents, contributed independently to the shared hook runtime.

## In Scope

- The thirteen source rule implementations, including the three source-only rules and ten edit contributions shared in concept with code-rules.
- Source rule registration, custom source rules and match rules.
- `wp-ai-rules-hook`, its source pipeline, and source fixtures and golden tests.

## Out of Scope

- Workflow guards, state, logging and hook installation (agent-workflow-rules).
- Protocol normalization and generic rule evaluation (hook-runtime).
- Git and worktree primitives (repo-workflow-core).
- Config validation (rules-config), committed-diff validation (code-rules), and aggregate packaging (nx-webpieces-rules).
