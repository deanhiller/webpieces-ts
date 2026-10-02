# Responsibilities — agent-workflow-rules

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
