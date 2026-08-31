import { describe, it, expect } from 'vitest';

import { denyJson } from './agent-response';
import { ClaudeCodeAdapter } from './claude-code-adapter';
import { AgentHookEvent } from '../core/agent-event';

/**
 * THE REGRESSION PIN FOR "CLAUDE CODE DID NOT MOVE".
 *
 * Every string below was CAPTURED from the implementation as it stood BEFORE the AgentHookEvent
 * refactor, by running the old `denyJson(reason, toolName)` and printing its bytes. They are pasted
 * here as literals on purpose: a spec that recomputes the expectation from the same code it is testing
 * cannot detect the code changing. These four lines are the only artifact in the repo that remembers
 * what the old implementation emitted.
 *
 * If one of these fails, a Claude Code deny changed shape on the wire — which is a bug in whatever
 * changed it, not in this file. Do not update the literals to match new output.
 *
 * `\\u001b` is how JSON.stringify serializes the ANSI escape, so the payload stays valid JSON with no
 * raw ESC byte anywhere in this source file.
 *
 * KEPT alongside `hook-app-golden.spec.ts`, and the two are not duplicates: this file pins the WIRE
 * SHAPE of `denyJson` over a matrix no composed run reaches — five tool names crossed with three
 * flavours of empty reason, plus the identical-bytes-for-Codex claim — and it does so with no repo, no
 * git and no rule engine, so it stays readable and fast. The golden spec pins the OTHER half: that a
 * whole invocation still routes to those bytes. A change that broke either alone would be a real
 * regression, and only one of the two files would say which layer moved.
 */
const BASH_ONELINE = '{"systemMessage":"\\u001b[31;1m🛑 boom\\u001b[0m","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boom"}}';
const WRITE_ONELINE = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"boom"}}';
const BASH_MULTI = '{"systemMessage":"\\u001b[31;1m🛑 headline here\\u001b[0m\\nline two\\nline three","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"headline here\\nline two\\nline three"}}';
const EDIT_MULTI = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"headline here\\nline two\\nline three"}}';

const MULTI_REASON = 'headline here\nline two\nline three';

function claudeEvent(toolName: string): AgentHookEvent {
    return new ClaudeCodeAdapter().envelope({ tool_name: toolName, tool_input: {} });
}

describe('Claude Code deny bytes are unchanged by the AgentHookEvent refactor', () => {
    it('emits the pre-refactor bytes for a single-line Bash deny (with the ANSI-red systemMessage)', () => {
        expect(denyJson(claudeEvent('Bash'), 'boom')).toBe(BASH_ONELINE);
    });

    it('emits the pre-refactor bytes for a single-line Write deny (no systemMessage)', () => {
        expect(denyJson(claudeEvent('Write'), 'boom')).toBe(WRITE_ONELINE);
    });

    it('emits the pre-refactor bytes for a multi-line Bash deny', () => {
        expect(denyJson(claudeEvent('Bash'), MULTI_REASON)).toBe(BASH_MULTI);
    });

    it('emits the pre-refactor bytes for a multi-line Edit deny', () => {
        expect(denyJson(claudeEvent('Edit'), MULTI_REASON)).toBe(EDIT_MULTI);
    });

    it('emits the same bytes for MultiEdit as for Edit — neither carries a systemMessage', () => {
        expect(denyJson(claudeEvent('MultiEdit'), MULTI_REASON)).toBe(EDIT_MULTI);
    });

    /**
     * The verified finding this whole change rests on: Codex accepts the identical deny wire. So a
     * Codex deny of the same kind is the SAME BYTES — there is no per-harness output morphing anywhere,
     * and if someone ever adds one, this fails.
     */
    it('emits identical bytes for a Codex deny of the same kind', () => {
        const codexBash = new AgentHookEvent('codex', 'Bash', 'Bash', '/repo', 's', '', 'default', [], null, []);
        const codexFile = new AgentHookEvent('codex', 'File', 'apply_patch', '/repo', 's', '', 'default', [], null, []);
        expect(denyJson(codexBash, 'boom')).toBe(BASH_ONELINE);
        expect(denyJson(codexFile, 'boom')).toBe(WRITE_ONELINE);
    });

    /**
     * Codex HARD-REJECTS a deny whose permissionDecisionReason is empty, where Claude tolerates one and
     * simply shows the human nothing. An empty reason is therefore not cosmetic — it is a block that
     * silently fails to block. Nothing in the hook is allowed to emit one.
     */
    it.each(['Bash', 'Write', 'Edit', 'MultiEdit', 'Read'])('never emits an empty permissionDecisionReason on a %s deny', (tool: string) => {
        for (const reason of ['', '   ', '\n\n']) {
            const json = denyJson(claudeEvent(tool), reason);
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            const parsed = JSON.parse(json) as { hookSpecificOutput: { permissionDecisionReason: string } };
            expect(parsed.hookSpecificOutput.permissionDecisionReason.trim()).not.toBe('');
        }
    });
});
