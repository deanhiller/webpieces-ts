import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';

import { ReviewIdentityStamp, ReviewIdentityStampService, REVIEW_STAMP_MAX_AGE_MS } from './review-identity-stamp';
import { specTempDirs } from './spec-temp-dirs';

function gitRepo(): string {
    const root = specTempDirs.makeReal('wp-review-stamp-');
    execSync('git init -q', { cwd: root });
    return root;
}

function stamp(checklistId: string, agentId: string, stampedAt: string = new Date().toISOString()): ReviewIdentityStamp {
    return new ReviewIdentityStamp(checklistId, 'codex', 'sess-1', agentId, 'default', '/repo', stampedAt);
}

describe('ReviewIdentityStampService.invokedChecklists — which Bash calls get a stamp', () => {
    const service = new ReviewIdentityStampService();

    it('returns nothing for a command that does not invoke the bin', () => {
        expect(service.invokedChecklists('pnpm wp-review-upsert-pr --checklist x')).toEqual([]);
        expect(service.invokedChecklists('cat review-security.json')).toEqual([]);
    });

    it('returns every checklist a command submits, in both flag spellings, once each', () => {
        const command = "pnpm wp-write-review --checklist security --file /tmp/a.json && "
            + "pnpm wp-write-review --checklist=error-output <<'EOF'\n{}\nEOF\n"
            + 'pnpm wp-write-review --checklist "security" --file /tmp/b.json';
        expect(service.invokedChecklists(command)).toEqual(['security', 'error-output']);
    });
});

describe('ReviewIdentityStampService write + take — one hook call vouches for one submission', () => {
    it('round-trips a stamp and consumes it on read', () => {
        const root = gitRepo();
        const service = new ReviewIdentityStampService();
        service.write(root, stamp('security', 'agent-7'));
        const taken = service.take(root, 'security');
        expect(taken?.agentId).toBe('agent-7');
        expect(taken?.aiType).toBe('codex');
        expect(fs.existsSync(service.stampPath(root, 'security'))).toBe(false);
        expect(service.take(root, 'security')).toBeNull();
    });

    it('never lends an EXPIRED stamp to a later caller', () => {
        const root = gitRepo();
        const service = new ReviewIdentityStampService();
        const old = new Date(Date.now() - REVIEW_STAMP_MAX_AGE_MS - 1_000).toISOString();
        service.write(root, stamp('security', 'agent-7', old));
        expect(service.take(root, 'security')).toBeNull();
    });

    it('keys stamps by checklist, so one checklist never picks up another\'s identity', () => {
        const root = gitRepo();
        const service = new ReviewIdentityStampService();
        service.write(root, stamp('security', 'agent-7'));
        expect(service.take(root, 'error-output')).toBeNull();
        expect(service.take(root, 'security')?.agentId).toBe('agent-7');
    });

    it('calls an empty agent id, or one equal to the session id, the COORDINATOR', () => {
        const service = new ReviewIdentityStampService();
        expect(service.isCoordinator(stamp('x', ''))).toBe(true);
        expect(service.isCoordinator(stamp('x', 'sess-1'))).toBe(true);
        expect(service.isCoordinator(stamp('x', 'agent-7'))).toBe(false);
    });
});
