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
npx wp-setup-ai-hooks
# Restart your Claude Code session
```

## Install (openclaw, per user)

```bash
openclaw plugins install @webpieces/ai-hook-rules
openclaw plugins enable @webpieces/ai-hook-rules
# Drop webpieces.config.json into any project you want checked
```

## Install (global hook, per user)

Wires a single shim into `~/.claude/settings.json` once. The shim
(`~/.webpieces/global-hook.js`) runs on every `Write|Edit|MultiEdit|Bash` and
**delegates to each repo's own `./node_modules/.bin/wp-ai-hook`** — so you install the
global hook one time and every webpieces project you have installed gets enforced
automatically, no per-project Claude Code wiring.

```bash
# from any repo that has @webpieces/ai-hook-rules installed (e.g. this one):
pnpm exec wp-setup-global-ai-hooks
#   or, equivalently:
./node_modules/.bin/wp-setup-global-ai-hooks
# Restart your Claude Code session
```

The command is interactive:

- **Not yet wired** → prompts `Install global webpieces hook…? [Y/n]`. On `Y` it copies the
  bundled `global-hook.js` → `~/.webpieces/global-hook.js` and appends the `PreToolUse`
  entry to `~/.claude/settings.json`.
- **Already wired** → prompts `Global hook is already installed. Uninstall? [y/N]`. To
  **refresh to the latest** version, run it twice: once answering `y` (uninstall), then
  again answering `Y` (re-install the current copy).

### How delegation works

The shim keys off `process.cwd()` — the directory you launched Claude Code from:

1. If `<cwd>/.webpieces/skiphooks` is present and unexpired → allow everything (escape hatch).
2. Writing `<cwd>/.webpieces/skiphooks` is always allowed.
3. If `<cwd>/node_modules/.bin/wp-ai-hook` exists → delegate the decision to it.
4. Otherwise → block and tell the AI to install the hook (or write a skiphooks).

Because resolution is cwd-based (not the edited file's path), launch Claude Code from the
directory whose `node_modules` contains the install. In a monorepo where only a subdir is a
webpieces project, launch from that subdir to get enforcement there.

### Temporarily skipping hooks

Drop a `skiphooks` file at the launch dir to bypass enforcement (e.g. for an umbrella repo
where only some subdirs are webpieces projects):

```bash
# <cwd>/.webpieces/skiphooks
{"expires": null, "reason": "why hooks are skipped here"}
```

`expires` is a unix-epoch-seconds number, or `null` to skip indefinitely. The check is
**exact to the launch dir** — it does not walk up — so a skiphooks at a parent dir does not
affect Claude Code launched from a child dir.

## Starter rules

- `no-any` — disallow the `any` keyword
- `max-file-lines` — cap file length
- `file-location` — every `.ts` must belong to a project's `src/`
- `no-destructure` — use explicit property access
- `require-return-type` — every function declares its return type
- `no-unmanaged-exceptions` — `try/catch` requires an explicit disable comment

See `webpieces.config.json` at your project root to toggle rules or tune options.
