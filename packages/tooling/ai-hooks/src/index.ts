/**
 * @webpieces/ai-hooks
 *
 * Pluggable write-time validation framework for AI coding agents.
 * Claude Code PreToolUse and openclaw before_tool_call share one rule engine.
 *
 * Adapters:
 *   - @webpieces/ai-hooks/claude-code    (shell-command hook entry)
 *   - @webpieces/ai-hooks/openclaw-plugin (openclaw plugin handler)
 *
 * Consumers writing custom rules import types from this barrel.
 */

export const VERSION = '0.0.0-dev';
