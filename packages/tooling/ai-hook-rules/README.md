# @webpieces/ai-hook-rules

Pluggable write-time validation framework for AI coding agents.

**Status: under construction.** See the plan file for the full design.

## What it does

Intercepts AI file writes before they happen. Runs a configurable rule set against the proposed content. Rejects writes that violate rules with an educational message the AI can use to fix its own output, instead of waiting for a build to catch the problem.

## Harnesses supported

- **Claude Code** — via `PreToolUse` hook in `.claude/settings.json`
- **openclaw** — via `before_tool_call` plugin hook

Both share the same rules and the same `webpieces.ai-hooks.json` config file.

## Install (Claude Code, per project)

```bash
npm install --save-dev @webpieces/nx-webpieces-rules  # pulls in ai-hook-rules transitively
npx wp-setup-ai-hooks
# Restart your Claude Code session
```

## Install (openclaw, per user)

```bash
openclaw plugins install @webpieces/ai-hook-rules
openclaw plugins enable @webpieces/ai-hook-rules
# Drop webpieces.ai-hooks.json into any project you want checked
```

## Starter rules

- `no-any` — disallow the `any` keyword
- `max-file-lines` — cap file length
- `file-location` — every `.ts` must belong to a project's `src/`
- `no-destructure` — use explicit property access
- `require-return-type` — every function declares its return type
- `no-unmanaged-exceptions` — `try/catch` requires an explicit disable comment

See `webpieces.ai-hooks.json` at your project root to toggle rules or tune options.
