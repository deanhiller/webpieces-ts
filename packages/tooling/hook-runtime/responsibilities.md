# Responsibilities — hook-runtime

Protocol-only runtime shared by hook products and PR tooling. It owns the normalized agent-event contract, exact PreToolUse response bytes, and the fail-closed application boundary without importing a concrete rule registry.

## In Scope

- Neutral harness identity values and normalized agent event, file operation, Bash input, and hook mode data types.
- Exact allow/deny outcome and PreToolUse JSON formatting, including Bash-only visible system messages.
- Injectable stdin, stdout, process-exit, and evaluator ports.
- `HookApp` orchestration and its last-resort fail-closed boot boundary.
- Protocol-focused tests and dependency assertions that keep both hook products above this package.

## Out of Scope

- Concrete source rules, workflow guards, rule loading, and rule evaluation (`ai-hook-rules`).
- Hook registration, installation, generated shims, and published hook binaries (`ai-hook-rules` at this stage).
- Repository/PR workflow state and PR gate commands (`rules-config` and `pr-gate`).
- Nx target registration and package bundling (`nx-webpieces-rules`).

## Notes (optional)

Hook products inject their evaluator implementation. Runtime changes therefore schedule both the hook product and PR gate, while source-rule-only changes do not pull PR gate into the affected graph.
