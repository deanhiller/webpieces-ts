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
- Generic config loading and validation (rules-config), PR orchestration (pr-gate), and aggregate packaging (nx-webpieces-rules).

The public source and guard hooks keep their existing binary names. Import shared rule contracts from `@webpieces/hook-runtime`, pure schema/value contracts from `@webpieces/rules-sdk` and concrete configuration types from their owner package, and errors from `@webpieces/tooling-common`. Workflow APIs previously imported from `ai-hook-rules` now belong to `agent-workflow-rules`. OpenClaw composition is provided by the umbrella package.

The committed dispatcher is upgraded from the installed published release; this extraction does not regenerate it from unreleased source.

This pack owns its concrete policy schemas, mode enums, optional tuning, and reviewed seeds. Workflow rule/field retirements and keyless safeguard metadata are published by the workflow owner.

## Reviewer submissions from linked worktrees

The guards hook writes the one-use reviewer identity stamp in the command's effective tree,
using the same leading `cd`/`pushd` resolver as the Bash guards. Session and agent identity
still come from the genuine hook payload. Submit with a literal absolute path:

```sh
cd '/absolute/reviewed-worktree' && pnpm wp-write-review --checklist checklist-id --file /absolute/verdict.json
```

A native Codex CLI 0.160.0 capture on 2026-10-03 showed that `exec_command` with
`cmd: "pwd"` and `workdir: "/private/tmp/wp-1105-probe/target"` executes in the target,
but PreToolUse receives `cwd: "/private/tmp/wp-1105-probe/session"` and
`tool_input: {"command": "pwd"}`. The execution workdir is absent. The captured envelope
is in `src/adapters/__fixtures__/codex-workdir-pre-tool-use.json`. `workdir` alone cannot
route a stamp; use the leading `cd` form even when also setting the tool's `workdir`.
[Official hook documentation](https://learn.chatgpt.com/docs/hooks) likewise defines
`cwd` as the session directory and normalizes unified exec to `Bash`.

On a missing/expired stamp, `wp-write-review` names the submission cwd and expected
worktree stamp path. Check hook delivery and tree selection before reinstalling hooks.
Never copy stamps between trees or substitute coordinator identity. This source change
takes effect in consumers after publication and upgrade of `@webpieces/agent-workflow-rules`.
