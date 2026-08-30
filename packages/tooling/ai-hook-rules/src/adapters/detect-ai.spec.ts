import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

import { AI_TYPE_SH, detectAiType } from './detect-ai';
import { AiType } from '../core/agent-event';

/**
 * The TWIN-AGREEMENT test, the same shape `l0-allowlist` uses for the L0 allowlist: the sh fragment and
 * the JS predicate must answer identically over a corpus, or L0's two halves disagree about which
 * harness they are guarding and nothing reports it.
 *
 * The sh side is exercised by actually RUNNING it under /bin/sh, not by re-implementing it in JS —
 * a re-implementation is a third answer, and a third answer is a third thing that can drift.
 */
function shAnswer(payload: string): string {
    const script = `PAYLOAD=$(cat); ${AI_TYPE_SH}; printf '%s' "$AI"`;
    return execFileSync('/bin/sh', ['-c', script], { input: payload, encoding: 'utf8' });
}

// Real envelope keys, from the measured Phase 0 capture of codex-cli 0.151.0 and from Claude Code.
const CLAUDE_BASH = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' },
    cwd: '/repo', session_id: 's1', transcript_path: '/t.jsonl',
});
const CLAUDE_EDIT = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
    cwd: '/repo', session_id: 's1', agent_id: '', agent_type: '',
});
// A Claude payload that MENTIONS turn_id the way an agent actually types it — bare, in a grep. The sh
// half matches the quoted key WITH its colon precisely so this stays a Claude call.
const CLAUDE_MENTIONS_TURN_ID = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'grep -rn turn_id packages/tooling/ai-hook-rules/src' },
    cwd: '/repo', session_id: 's1',
});
const CODEX_BASH = JSON.stringify({
    agent_id: '', agent_type: 'default', cwd: '/repo', hook_event_name: 'PreToolUse',
    model: 'gpt-5', permission_mode: 'auto', session_id: 's1',
    tool_input: { command: "sed -n '1,240p' /repo/a.ts" }, tool_name: 'Bash',
    tool_use_id: 'tu1', transcript_path: '/t.jsonl', turn_id: 'turn-1',
});
const CODEX_APPLY_PATCH = JSON.stringify({
    agent_id: 'a1', agent_type: 'default', cwd: '/repo', hook_event_name: 'PreToolUse',
    model: 'gpt-5', session_id: 's1',
    tool_input: { command: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch' },
    tool_name: 'apply_patch', tool_use_id: 'tu2', turn_id: 'turn-2',
});

const CORPUS: ReadonlyArray<readonly [string, string, AiType]> = [
    ['claude Bash', CLAUDE_BASH, 'claude-code'],
    ['claude Edit', CLAUDE_EDIT, 'claude-code'],
    ['claude Bash mentioning turn_id bare', CLAUDE_MENTIONS_TURN_ID, 'claude-code'],
    ['codex Bash', CODEX_BASH, 'codex'],
    ['codex apply_patch', CODEX_APPLY_PATCH, 'codex'],
];

describe('detectAiType / AI_TYPE_SH', () => {
    it.each(CORPUS)('%s → the expected aiType, from BOTH twins', (_name: string, payload: string, expected: AiType) => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        expect(detectAiType(JSON.parse(payload))).toBe(expected);
        expect(shAnswer(payload)).toBe(expected);
    });

    it('answers claude-code for anything that is not an object', () => {
        expect(detectAiType(null)).toBe('claude-code');
        expect(detectAiType('turn_id')).toBe('claude-code');
        expect(detectAiType(42)).toBe('claude-code');
    });

    it('is a KEY test, not a value test — a turn_id key with any value is codex', () => {
        expect(detectAiType({ turn_id: '' })).toBe('codex');
        expect(detectAiType({ turn_id: null })).toBe('codex');
    });
});
