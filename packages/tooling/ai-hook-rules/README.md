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

`wp-install-ai-hooks` wires two independent `PreToolUse` hooks into the chosen
`settings.json`, each invoked via the project's `./node_modules/.bin/`:

- `wp-ai-rules-hook` — matcher `Write|Edit|MultiEdit`. Runs the code-style rules.
- `wp-ai-guards-hook` — matcher `Write|Edit|MultiEdit|Bash|Read`. Runs the git/PR/branch guards
  (`hookGuards` section): bash git/PR guards on `Bash`, and file guards like
  `feature-branch-guard` on `Write|Edit|MultiEdit`. `Read` carries no guard — it is a
  log-and-allow fast path that records every file the AI opens in `.webpieces/hooks/guard-invocations.log`
  (never blocked), so you can see whether the AI read a project's `design.json` before editing it.

For each hook the setup command prompts for a target: project `.claude/settings.json`,
personal `.claude/settings.local.json`, the global `~/.claude/settings.json` (this-repo-only),
or **none** (= uninstall). Installing and uninstalling are the same operation — pick a
location, or pick "none" to remove the hook from every target.

### Disabling enforcement

There is no runtime escape-hatch file. To stop enforcement, **uninstall the hook**
(re-run `wp-install-ai-hooks` and choose "none" for it). Per-rule opt-outs stay in
`webpieces.config.json` (`mode: "OFF"`, `ignoreModifiedUntilEpoch`, `ignoreRuleWhileOnBranch`)
and per-line opt-outs use `// webpieces-disable <rule> -- reason`.

## Starter rules

- `no-any` — disallow the `any` keyword
- `max-file-lines` — cap file length
- `file-location` — every `.ts` must belong to a project's `src/`
- `no-destructure` — use explicit property access
- `require-return-type` — every function declares its return type
- `no-unmanaged-exceptions` — `try/catch` requires an explicit disable comment

See `webpieces.config.json` at your project root to toggle rules or tune options.
