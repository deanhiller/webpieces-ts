import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeMainSyncStatus, MainSyncStatus } from '@webpieces/rules-config';

import { logGuardInvocation, logGuardDecision, GuardDecision } from './decision-log';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guardinv-'));
}

const LOG_REL = '.webpieces/hooks/guard-invocations.log';
const DECISION_LOG_REL = '.webpieces/hooks/guard-sync-decisions.log';

// The temp dirs are not git repos and have no webpieces.config.json, so resolveRepoRoot falls back to
// the passed dir (the temp root) and branchForLog returns 'unknown' — exactly the fail-open behavior
// we want to assert stays non-fatal.
describe('logGuardInvocation', () => {
    it('appends one tab-separated line with tool, target, branch and sync=none when no cache exists', () => {
        const root = tmpRoot();
        logGuardInvocation(root, 'Bash', 'pnpm run build-all');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tBash\t');
        expect(content).toContain('pnpm run build-all');
        expect(content).toContain('branch=');
        expect(content).toContain('sync=none');
        expect(content.trim().split('\n').length).toBe(1);
    });

    it('folds the main-sync-status.json fields (branch, merged PR, fork, conflict) into the line', () => {
        const root = tmpRoot();
        writeMainSyncStatus(
            root,
            new MainSyncStatus('dean/foo', true, '271', true, 'abc123', 'o', 'f', false, [], '2026-07-06T00:00:00.000Z'),
        );
        logGuardInvocation(root, 'Edit', 'src/x.ts');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tEdit\t');
        expect(content).toContain('sync=dean/foo');
        expect(content).toContain('merged=PR#271');
        expect(content).toContain('fork=true');
        expect(content).toContain('conflict=false');
    });

    it('collapses newlines/tabs in the target so one invocation is always one line', () => {
        const root = tmpRoot();
        logGuardInvocation(root, 'Bash', 'echo one\ntwo\tthree');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content.trim().split('\n').length).toBe(1);
        expect(content).toContain('echo one two three');
    });

    it('rotates to guard-invocations.1.log once the log exceeds the size cap', () => {
        const root = tmpRoot();
        const hooksDir = path.join(root, '.webpieces/hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(path.join(hooksDir, 'guard-invocations.log'), 'x'.repeat(512 * 1024 + 10));
        logGuardInvocation(root, 'Bash', 'ls');
        expect(fs.existsSync(path.join(hooksDir, 'guard-invocations.1.log'))).toBe(true);
        expect(fs.readFileSync(path.join(hooksDir, 'guard-invocations.log'), 'utf8')).toContain('\tBash\t');
    });

    // The read-only fast path (hook-core.ts) logs a Read via this same function, so the file the AI
    // opened lands in guard-invocations.log — this is the "did it read design.json first?" signal.
    it('records a Read of a design.json so opened files are visible in the history', () => {
        const root = tmpRoot();
        logGuardInvocation(root, 'Read', 'packages/tooling/pr-gate/design.json');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tRead\t');
        expect(content).toContain('packages/tooling/pr-gate/design.json');
    });
});

// logGuardDecision backs the blocked-Bash audit (hook-core.ts handleBash) — previously a denied Bash
// left no trail. A BLOCK line must carry the tool, the command, and the reason ("blocked and why").
describe('logGuardDecision', () => {
    it('records a Bash BLOCK with its command and reason', () => {
        const root = tmpRoot();
        logGuardDecision(
            root,
            new GuardDecision('bash-guard', 'Bash', 'gh pr create -t x', 'dean/foo', 'BLOCK', 'use pnpm wp-start-upsert-pr instead'),
        );
        const content = fs.readFileSync(path.join(root, DECISION_LOG_REL), 'utf8');
        expect(content).toContain('\tBLOCK\t');
        expect(content).toContain('\tBash\t');
        expect(content).toContain('gh pr create');
        expect(content).toContain('use pnpm wp-start-upsert-pr instead');
        expect(content.trim().split('\n').length).toBe(1);
    });
});
