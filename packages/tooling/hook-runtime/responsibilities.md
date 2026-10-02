# Responsibilities — hook-runtime

Neutral hook protocol, event normalization, contributed rule evaluation and fail-closed application boundary.

## In Scope

- Harness envelope parsing and normalization into agent events and file operations.
- Rule contexts, scope-specific bases, exclusion and delete scoping, report formatting and generic evaluation of caller-provided rule sets.
- HookApp, injected process ports and the decision wire protocol.

## Out of Scope

- Concrete source or workflow policy, registries and configuration schemas.
- Workflow state, logging, sync, shim installation and setup.
- Git/worktree primitives and PR orchestration.
