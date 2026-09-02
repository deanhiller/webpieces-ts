# @webpieces/ai-hook-rules

Pluggable write-time validation framework for AI coding agents.

**Status: under construction.** See the plan file for the full design.

## What it does

Intercepts AI file writes before they happen. Runs a configurable rule set against the proposed content. Rejects writes that violate rules with an educational message the AI can use to fix its own output, instead of waiting for a build to catch the problem.

## Harnesses supported

- **Claude Code** — via `PreToolUse` hook in `.claude/settings.json`
- **openclaw** — via `before_tool_call` plugin hook

Both share the same rules and the same `webpieces.config.json` config file.

## Install (Claude Code, per project)

```bash
npm install --save-dev @webpieces/nx-webpieces-rules  # pulls in ai-hook-rules transitively
npx wp-install-ai-hooks
# Restart your Claude Code session
```

## Install (openclaw, per user)

```bash
openclaw plugins install @webpieces/ai-hook-rules
openclaw plugins enable @webpieces/ai-hook-rules
# Drop webpieces.config.json into any project you want checked
```

## The two hooks (Claude Code)

`wp-install-ai-hooks` wires two `PreToolUse` hooks into the chosen `settings.json`, **both registered
with an absolute `$CLAUDE_PROJECT_DIR/` path** so they resolve from any cwd:

- `wp-ai-rules-hook` — matcher `Write|Edit|MultiEdit`. Runs the code-style rules.
- `wp-ai-guards-hook` — matcher `Write|Edit|MultiEdit|Bash|Read`. Runs the git/PR/branch guards. The
  `hookGuards` section carries exactly THREE keys, one per POLICY — `branch-state-guard`
  ("may I work here, and is what I read current?"), `branch-creation-guard` ("should this branch or
  worktree exist?") and `pr-lifecycle-guard` ("do PRs and merges go through the gated flow?"). Several
  guard CLASSES sit behind each key, because the tool wiring differs even where the policy does not:
  bash git/PR guards on `Bash`, and file guards like `feature-branch-guard` (a class under
  `branch-state-guard`) on `Write|Edit|MultiEdit`. A class name is what a deny report and a decision-log
  line carry as `rule=`; a config key is what you switch. `Read` is guarded ONLY by
  `read-stale-guard` — another class under `branch-state-guard` — which blocks a read of a stale tree;
  otherwise it is a
  log-and-allow fast path that records every file the AI opens in
  `.webpieces/logs/calls/<session>-<agent>-<hook>.log`
  (never blocked), so you can see whether the AI read a project's `design.json` before editing it.

For each guard hook the setup command prompts for a target: project `.claude/settings.json`,
personal `.claude/settings.local.json`, the global `~/.claude/settings.json` (this-repo-only),
or **none** (= uninstall). Installing and uninstalling are the same operation — pick a
location, or pick "none" to remove the hook from every target.

**There is no third `cd` hook any more.** A `guarantee-root.sh` used to be registered alongside these
two, denying any `cd` into a project subdirectory, because the two guard hooks were registered
**relative** — the point being that each git tree would then be governed by its own installed release
rather than the primary clone's — and a relative hook that fails to resolve exits 127, which the harness
treats as a non-blocking error that lets the tool call proceed UNGUARDED. Measured 2026-08-10, the
relative registration never delivered that: a linked worktree has no `node_modules`, so this script's
upward walk always executed the MAIN tree's binary (`readlink -f` resolved a worktree agent's bin to
`<primary>/node_modules/@webpieces/ai-hook-rules`). A worktree ran its own script and its own config,
never its own release — governance was always the primary's. Both hooks are absolute now, the launch
guarantee is structural, `cd` into a subdirectory is simply allowed, and version skew between trees is
caught where it actually lives: the `trinary-version-skew` L1 row (`core/version-sync.ts`).

### Keeping the three in step

The installed surface is three things — `.claude/webpieces/ai-hook.sh`, the `settings.json` entries
registering the two hooks, and the `settings.json` `env` entry
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` — and they only
work as a set. The guards binary compares all three against the release it came from and fails closed
on any mismatch, naming which one moved. **`pnpm exec wp-upgrade-shim`** regenerates all three
(rewriting an old relative registration to the absolute form rather than adding beside it, and removing
a leftover `guarantee-root.sh` registration) and is
allowed through while that block is up. Its NAME is older than its job — it has not been shim-only
since 2026-08-07 — and it is deliberately not renamed, because a rename with no functional change costs
every consumer and buys nothing.

#### Why webpieces manages `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`

Set to `1`, Claude Code resets the shell's cwd to the project directory after every Bash call. That is
guard integrity, not ergonomics:

- a `cd` that stays INSIDE the workspace otherwise PERSISTS to later calls, so a guard verdict would
  depend on whatever `cd` happened earlier in the session — including one from an unrelated command
  several turns ago. Resetting makes every call start from a known directory;
- settings `env` is **inherited**, so the main agent and every subagent start each Bash call from the
  same cwd, and therefore get the same verdict for the same command;
- it keeps `$CLAUDE_PROJECT_DIR` and the shell's cwd in agreement by default, which is what makes the
  `tree=` / `root=` columns in the audit log mean what a reader assumes they mean.

(This entry once had a load-bearing safety job — the hooks were registered relative, and a relative
path that cannot resolve exits 127, which the Claude Code hooks reference defines as a NON-BLOCKING
error, i.e. a **silent unguarded allow**. Both hooks are absolute now, so that hazard is gone and this
is about verdict stability, not launchability.)

The trade, said out loud: with the flag on, the cwd reset is **silent and unconditional**, where without
it the reset is conditional and prints a visible notice. A deliberate `cd` no longer persists across
Bash calls — chain instead (`cd <dir> && <cmd>`). The installer writes the entry, and `wp-upgrade-shim`
self-heals it; a settings file that registers no webpieces hooks is never touched.

### Disabling enforcement

There is no runtime escape-hatch file. To stop enforcement, **uninstall the hook**
(re-run `pnpm wp-install-ai-hooks` and choose "none" for it). Per-rule opt-outs stay in
`webpieces.config.json` (`mode: "OFF"`, `turnOffRuleUntilEpoch`, `turnOffRuleWhileOnBranch`)
and per-line opt-outs use `// webpieces-disable <rule> -- reason`.

## Starter rules

- `no-any` — disallow the `any` keyword
- `max-file-lines` — cap file length (machine-generated trees — `**/__generated__/**`, `**/generated/**`,
  `**/*.generated.ts(x)`, `dist` — are exempt with no configuration; `allowedPaths` adds your own
  un-authored trees to that list, and is never for hand-written code)
- `file-location` — every `.ts` must belong to a project's `src/`
- `no-destructure` — use explicit property access
- `require-return-type` — every function declares its return type
- `no-unmanaged-exceptions` — `try/catch` requires an explicit disable comment

See `webpieces.config.json` at your project root to toggle rules or tune options.
