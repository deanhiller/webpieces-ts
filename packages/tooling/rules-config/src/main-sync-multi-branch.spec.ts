import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MainSyncStatusService } from './main-sync-status';

/**
 * The refresher is single-flight across the whole repo — one `.git`, one `origin/main`, one lock — but
 * it used to write a status for only the ONE branch whose worktree happened to win. Every other
 * worktree's guards then read a cross-branch cache and abstained. These tests drive the real thing
 * against real linked worktrees and assert the winner now describes ALL of them.
 */

let tmp: string;
let primary: string;
let treeB: string;
let ghLog: string;
let pathBefore: string;
const service = new MainSyncStatusService();

function sh(script: string): void {
    execSync(script, { shell: '/bin/sh', stdio: 'pipe' });
}

/**
 * A `gh` stub that RECORDS every invocation, so a test can assert the network cost. It exits non-zero
 * (no PRs), which is the same answer the real gh gives for a repo with no GitHub remote — the point
 * here is the call COUNT, not the payload.
 */
function stubGh(binDir: string, logFile: string): void {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\necho "$@" >> ${logFile}\nexit 1\n`, { mode: 0o755 });
    pathBefore = process.env['PATH'] ?? '';
    process.env['PATH'] = `${binDir}${path.delimiter}${pathBefore}`;
}

// A primary clone on `deanhiller/a` plus a linked worktree on `deanhiller/b`. NOTHING is on `main`,
// which is the shape that proves the synthesized main entry is needed.
function makeRepo(): void {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msmb-')));
    primary = path.join(tmp, 'primary');
    treeB = path.join(tmp, 'tree-b');
    ghLog = path.join(tmp, 'gh-calls.log');
    sh([
        'set -e',
        // A REAL (local path) origin so the refresher's one `git fetch` succeeds instantly instead of
        // paying a failed-remote round trip on every compute.
        `git init -q --bare -b main ${path.join(tmp, 'origin.git')}`,
        `git init -q -b main ${primary}`,
        `cd ${primary}`,
        'git config core.hooksPath /dev/null',
        'git config user.email t@t.t',
        'git config user.name t',
        'git config commit.gpgsign false',
        "printf 'base\\n' > shared.txt",
        'git add -A',
        'git commit -q -m base',
        `git remote add origin ${path.join(tmp, 'origin.git')}`,
        'git push -q origin main',
        'git checkout -q -b deanhiller/a',
        `git worktree add -q -b deanhiller/b ${treeB}`,
    ].join('\n'));
    stubGh(path.join(tmp, 'bin'), ghLog);
}

function ghCallCount(): number {
    if (!fs.existsSync(ghLog)) return 0;
    return fs.readFileSync(ghLog, 'utf8').split('\n').filter((l: string): boolean => l.trim() !== '').length;
}

beforeEach(() => { makeRepo(); });

afterEach(() => {
    process.env['PATH'] = pathBefore;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('computeAllMainSyncStatuses — every worktree in one map', () => {
    // TEST 1: the regression this whole change exists for. Two worktrees, two branches, both described
    // by the single winning refresh, so neither worktree's guards can hit the cross-branch bail-out.
    it('records EVERY worktree branch, not just the tree it ran in', () => {
        const file = service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches).sort()).toEqual(['deanhiller/a', 'deanhiller/b', 'main']);
        // Each entry is keyed by, and self-reports, the same branch — the guards' belt-and-braces
        // `status.branch !== branch` assertion must be unreachable.
        for (const [name, status] of Object.entries(file.branches)) {
            expect(status.branch).toBe(name);
        }
        // And each entry is a REAL status, computed in that worktree: the two feature branches sit on
        // their own HEADs, so their featureHeads are recorded rather than shared.
        expect(file.branches['deanhiller/a']?.featureHead).not.toBe('');
        expect(file.branches['deanhiller/b']?.featureHead).not.toBe('');
        expect(file.version).toBe(2);
    });

    // TEST 6: read-stale-guard's state A looks itself up under 'main'. With nothing checked out on
    // main, an absent entry would silently disarm the stale-main block.
    it('always includes main, even with no worktree standing on it', () => {
        const file = service.computeAllMainSyncStatuses(primary);
        const main = file.branches['main'];
        expect(main).toBeDefined();
        expect(main?.branch).toBe('main');
        // It carries the two hashes the stale-main guards actually compare.
        expect(main?.originMain).not.toBe('');
        expect(main?.localMain).not.toBe('');
        // And it can never produce a merged-branch or conflict block.
        expect(main?.branchAlreadyMerged).toBe(false);
        expect(main?.conflict).toBe(false);
    });

    // TEST 5: a detached worktree has no branch to key an entry on. Skipping it must not cost the
    // other worktrees their entries.
    it('skips a detached-HEAD worktree without dropping the others', () => {
        const detached = path.join(tmp, 'tree-detached');
        sh(`cd ${primary} && git worktree add -q --detach ${detached}`);

        const file = service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches).sort()).toEqual(['deanhiller/a', 'deanhiller/b', 'main']);
        expect(Object.keys(file.branches)).not.toContain('');
    });

    // TEST 7: the map is rebuilt from the LIVE worktree set every refresh, so nothing accumulates and
    // no pruning pass is needed.
    it('drops a removed worktree\'s branch on the next refresh', () => {
        expect(Object.keys(service.computeAllMainSyncStatuses(primary))).toBeDefined();
        sh(`cd ${primary} && git worktree remove ${treeB} && git branch -q -D deanhiller/b`);

        const file = service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches).sort()).toEqual(['deanhiller/a', 'main']);
    });

    // TEST 9: the network cost must NOT scale with branch count. The old code asked `gh` twice PER
    // BRANCH, so looping worktrees would have cost 2N round trips per refresh.
    it('makes exactly ONE gh call no matter how many branches it records', () => {
        const treeC = path.join(tmp, 'tree-c');
        const treeD = path.join(tmp, 'tree-d');
        sh([`cd ${primary}`, `git worktree add -q -b deanhiller/c ${treeC}`,
            `git worktree add -q -b deanhiller/d ${treeD}`].join(' && '));

        const file = service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches)).toHaveLength(5);
        expect(ghCallCount()).toBe(1);
    });

    // Regression pin on the single-branch entry point too: it used to make TWO gh calls.
    it('computeMainSyncStatus makes one gh call for its single branch', () => {
        service.computeMainSyncStatus(primary);
        expect(ghCallCount()).toBe(1);
    });

    // The whole map is written as ONE atomic document, and every worktree reads the same path — so a
    // guard in tree B finds tree B's entry through the file written by the refresher in the primary.
    it('round-trips the map through the shared file, readable from every worktree', () => {
        service.writeMainSyncStatusFile(primary, service.computeAllMainSyncStatuses(primary));

        expect(service.mainSyncStatusPath(treeB)).toBe(service.mainSyncStatusPath(primary));
        expect(service.readMainSyncStatus(treeB, 'deanhiller/b')?.branch).toBe('deanhiller/b');
        expect(service.readMainSyncStatus(primary, 'deanhiller/a')?.branch).toBe('deanhiller/a');
        expect(service.readMainSyncStatus(treeB, 'never/created')).toBeNull();
    });
});
