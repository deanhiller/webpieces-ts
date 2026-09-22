import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

import { ReviewIdentityStampService, specTempDirs } from '@webpieces/rules-config';

import { ReviewIdentityStamper } from './review-identity-stamper';
import { CodexAdapter } from './codex-adapter';
import { ClaudeCodeAdapter } from './claude-code-adapter';

function gitRepo(): string {
    const root = specTempDirs.makeReal('wp-review-stamper-');
    execSync('git init -q', { cwd: root });
    return root;
}

/**
 * The hook half of `wp-write-review`'s identity (issue #863): the bin cannot tell a reviewer from its
 * coordinator from its environment, so the hook — which the harness hands `agent_id` — stamps it.
 */
describe('ReviewIdentityStamper — the hook tells wp-write-review who is calling', () => {
    const service = new ReviewIdentityStampService();
    const stamper = new ReviewIdentityStamper(service);

    it('stamps a Codex SUBAGENT submitting a verdict with its own agent id', () => {
        const root = gitRepo();
        const command = "pnpm wp-write-review --checklist security <<'EOF'\n{}\nEOF";
        const event = new CodexAdapter().toEvent({
            tool_name: 'Bash', tool_input: { command }, turn_id: 't1', session_id: 'sess-1', agent_id: 'agent-9', agent_type: 'default',
        }, root);
        stamper.stamp(event, command, root);
        const taken = service.take(root, 'security');
        expect(taken?.aiType).toBe('codex');
        expect(taken?.agentId).toBe('agent-9');
        expect(taken !== null && service.isCoordinator(taken)).toBe(false);
    });

    it('stamps the COORDINATOR too — with the empty agent id the bin then refuses', () => {
        const root = gitRepo();
        const command = 'pnpm wp-write-review --checklist security --file /tmp/v.json';
        const event = new ClaudeCodeAdapter().toEvent({
            tool_name: 'Bash', tool_input: { command }, session_id: 'sess-1',
        }, root);
        stamper.stamp(event, command, root);
        const taken = service.take(root, 'security');
        expect(taken?.aiType).toBe('claude-code');
        expect(taken !== null && service.isCoordinator(taken)).toBe(true);
    });

    it('writes nothing for a command that does not submit a verdict', () => {
        const root = gitRepo();
        const command = 'pnpm wp-review-upsert-pr';
        const event = new ClaudeCodeAdapter().toEvent({ tool_name: 'Bash', tool_input: { command } }, root);
        stamper.stamp(event, command, root);
        expect(service.take(root, 'security')).toBeNull();
    });
});
