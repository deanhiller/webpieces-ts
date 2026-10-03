# @webpieces/ai-hook-rules

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

The public source and guard hooks keep their existing binary names. Import shared rule contracts from `@webpieces/hook-runtime`, pure schema/value contracts from `@webpieces/rules-sdk` and concrete configuration types from their owner package, and errors from `@webpieces/tooling-common`. Workflow APIs previously imported from `ai-hook-rules` now belong to `agent-workflow-rules`. OpenClaw composition is provided by the umbrella package.

The committed dispatcher is upgraded from the installed published release; this extraction does not regenerate it from unreleased source.

This pack owns its concrete policy schemas, mode enums, optional tuning, and reviewed seeds. Workflow rule/field retirements and keyless safeguard metadata are published by the workflow owner.
