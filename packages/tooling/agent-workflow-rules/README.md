# @webpieces/agent-workflow-rules

Workflow guard policy and hook installation for AI coding agents, contributed independently to the shared hook runtime.

## In Scope

- Branch creation, branch state and PR lifecycle rule registration, plus fixed Bash guards.
- Guard pipeline, logging, main-sync refresh and version synchronization.
- Codex shared-tree protection, read parity enforcement and review identity stamping.
- `wp-ai-guards-hook`, hook installation, shim renderers and upgrade commands.
- Guard golden fixtures and L0 shell regression tests.

## Out of Scope

- Source rule implementations and their registry (ai-hook-rules).
- Generic protocol and rule evaluation (hook-runtime).
- Git/worktree primitives and state paths (repo-workflow-core and tooling-common).
- Config schemas and loading (rules-config), PR orchestration (pr-gate), and aggregate packaging (nx-webpieces-rules).

The public source and guard hooks keep their existing binary names. Import shared rule contracts from `@webpieces/hook-runtime`, configuration types from `@webpieces/rules-config`, and errors from `@webpieces/tooling-common`. Workflow APIs previously imported from `ai-hook-rules` now belong to `agent-workflow-rules`. OpenClaw composition is provided by the umbrella package.

The committed dispatcher is upgraded from the installed published release; this extraction does not regenerate it from unreleased source.
