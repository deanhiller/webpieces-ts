# Responsibilities — ai-hook-rules

Source edit validation for AI coding agents, contributed independently to the shared hook runtime.

## In Scope

- Fourteen source rule implementations, including method-size and keyword-type checks shared with the build gate.
- Source rule registration, custom source rules and match rules.
- `wp-ai-rules-hook`, its source pipeline, and source fixtures and golden tests.

## Out of Scope

- Workflow guards, state, logging and hook installation (agent-workflow-rules).
- Protocol normalization and generic rule evaluation (hook-runtime).
- Git and worktree primitives (repo-workflow-core).
- Config validation (rules-config), committed-diff validation (code-rules), and aggregate packaging (nx-webpieces-rules).

This pack owns its concrete policy schemas, mode enums, optional tuning, and reviewed seeds. Workflow rule/field retirements and keyless safeguard metadata are published by the workflow owner.
