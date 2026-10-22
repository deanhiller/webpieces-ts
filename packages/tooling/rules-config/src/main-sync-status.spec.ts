import { checkoutLayout, policyFixture, ProcessCallDto } from '@webpieces/tooling-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GitResultDto } from '@webpieces/tooling-common';

import { MainSyncStatus, MainSyncStatusService, readMainSyncStatus, writeMainSyncStatus, squashRecoverySteps } from '@webpieces/repo-workflow-core';
import { RulesConfigFeature } from './__tests__/rules-config-feature';


function tmpRepoRoot(): string {
    return policyFixture.makeRepo('mss-');
}

describe('main-sync status IO', () => {
    let root: string;
    beforeEach(() => { root = tmpRepoRoot(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('round-trips a status', () => {
        const status = new MainSyncStatus('dean/x', false, '', true, 'aaa', 'bbb', 'ccc', true, ['p/q.ts'], '2026-06-30T00:00:00.000Z');
        writeMainSyncStatus(root, status);
        const read = readMainSyncStatus(root, 'dean/x');
        expect(read).not.toBeNull();
        expect(read?.conflict).toBe(true);
        expect(read?.conflictFiles).toEqual(['p/q.ts']);
        expect(read?.hasForkPoint).toBe(true);
        expect(read?.branch).toBe('dean/x');
        expect(read?.branchAlreadyMerged).toBe(false);
        expect(read?.commitsBehind).toBeNull();
    });

    it('round-trips branchAlreadyMerged + mergedPr', () => {
        const status = new MainSyncStatus('dean/x', true, '42', true, 'aaa', 'bbb', 'ccc', false, [], 'ts');
        writeMainSyncStatus(root, status);
        const read = readMainSyncStatus(root, 'dean/x');
        expect(read?.branchAlreadyMerged).toBe(true);
        expect(read?.mergedPr).toBe('42');
    });

    it('round-trips openPr (defaulted field, not in the positional constructor)', () => {
        const status = new MainSyncStatus('dean/x', false, '', true, 'aaa', 'bbb', 'ccc', true, ['q.ts'], 'ts');
        status.openPr = '303';
        writeMainSyncStatus(root, status);
        expect(readMainSyncStatus(root, 'dean/x')?.openPr).toBe('303');
        // A legacy cache with no openPr key reads back as '' (fail-safe default).
        expect(new MainSyncStatus('b', false, '', true, null, '', '', false, [], 'ts').openPr).toBe('');
    });

    it('returns null for a missing file', () => {
        expect(readMainSyncStatus(root, 'dean/x')).toBeNull();
    });

    it('returns null for malformed JSON (fail-open)', () => {
        fs.mkdirSync(path.join(root, '.webpieces'), { recursive: true });
        fs.writeFileSync(path.join(root, '.webpieces', 'main-sync-status.json'), '{ not json');
        expect(readMainSyncStatus(root, 'dean/x')).toBeNull();
    });
});

describe('squashRecoverySteps', () => {
    it('names the current branch in the new-branch and squash-source steps', () => {
        const steps = squashRecoverySteps('dean/foo').join('\n');
        expect(steps).toContain('dean/foo-v2');
        expect(steps).toContain('git merge --squash dean/foo');
    });
});

const FORK = 'fork-sha';

/**
 * What git knows about one feature checkout (#1381): the tips, the fork point with origin/main, and which
 * files each side changed — committed on the feature branch since the fork point, unstaged, staged,
 * untracked, and committed on origin/main since the fork point. The mocked git edge answers every
 * command the refresh issues FROM this, exactly as git would, so each scenario holds what the program
 * concluded from git's answers (and what it asked), and no repository is built.
 */
class RepoState {
    head = 'feature-sha';
    originMain = 'main-sha';
    localMain = 'main-sha';
    forkPoint: string | null = FORK;
    featureCommitted: string[] = [];
    unstaged: string[] = [];
    staged: string[] = [];
    untracked: string[] = [];
    mainChanged: string[] = [];
    commitsBehind = 0;
    // What a `git fetch` of origin/main brings in, applied when the program fetches.
    fetchedOriginMain: string | null = null;

    answer(call: ProcessCallDto): GitResultDto {
        const line = call.args.join(' ');
        if (line === 'fetch --no-write-fetch-head origin main') {
            if (this.fetchedOriginMain !== null) this.originMain = this.fetchedOriginMain;
            return new GitResultDto(0, '', '');
        }
        if (line === 'rev-parse HEAD') return this.ok(this.head);
        if (line === 'rev-parse origin/main') return this.ok(this.originMain);
        if (line === 'rev-parse refs/heads/main') return this.localMain === '' ? new GitResultDto(128, '', '') : this.ok(this.localMain);
        if (line === 'merge-base origin/main HEAD') return this.forkPoint === null ? new GitResultDto(1, '', '') : this.ok(this.forkPoint);
        if (line === `diff --name-only ${FORK} HEAD`) return this.files(this.featureCommitted);
        if (line === 'diff --name-only HEAD') return this.files(this.unstaged);
        if (line === 'diff --name-only --cached HEAD') return this.files(this.staged);
        if (line === 'ls-files --others --exclude-standard') return this.files(this.untracked);
        if (line === `diff --name-only ${FORK} origin/main`) return this.files(this.mainChanged);
        if (line === `rev-list --count ${this.localMain}..${this.originMain}`) return this.ok(String(this.commitsBehind));
        return new GitResultDto(1, '', `unscripted git ${line}`);
    }

    private ok(stdout: string): GitResultDto {
        return new GitResultDto(0, `${stdout}\n`, '');
    }

    private files(list: string[]): GitResultDto {
        return new GitResultDto(0, list.map((file: string): string => `${file}\n`).join(''), '');
    }
}

let work: string;
let repo: RepoState;
let feature: RulesConfigFeature;

beforeEach(async () => {
    // The checkout's HEAD names `feature` on disk — where the status reads the branch label from.
    work = specTempDirs.make('mss-work-');
    checkoutLayout.primary(work, 'feature');
    repo = new RepoState();
    feature = await RulesConfigFeature.create();
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => repo.answer(call));
    // `gh` could not answer (offline / no GitHub remote): no PR tracks the branch.
    feature.processes.respondToPrefix('gh', ['pr', 'list'], feature.processes.fail(1, 'no remote'));
});

afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
});

function computeMainSyncStatus(root: string): Promise<MainSyncStatus> {
    return feature.container.get(MainSyncStatusService).computeMainSyncStatus(root);
}

describe('computeMainSyncStatus (integration)', () => {
    it('records the REAL checked-out branch (not an env var)', async () => {
        // Set a misleading env var: the old getCurrentBranch would have returned it; gitBranch must not.
        const prev = process.env['GIT_BRANCH'];
        process.env['GIT_BRANCH'] = 'main';
        repo.featureCommitted = ['shared.txt'];
        repo.mainChanged = ['other.txt'];
        const status = await computeMainSyncStatus(work);
        if (prev === undefined) delete process.env['GIT_BRANCH']; else process.env['GIT_BRANCH'] = prev;
        expect(status.branch).toBe('feature');
    });

    it('computes commit distance in the slow status refresh', async () => {
        // One commit landed on origin/main that local main does not have.
        repo.localMain = 'old-main-sha';
        repo.originMain = 'upstream-sha';
        repo.commitsBehind = 1;

        expect((await computeMainSyncStatus(work)).commitsBehind).toBe(1);
        expect(feature.git.commandLines()).toContain('git rev-list --count old-main-sha..upstream-sha');
    });

    it('flags conflict=true when main and the branch touched the same file', async () => {
        repo.featureCommitted = ['shared.txt'];
        repo.mainChanged = ['shared.txt'];
        const status = await computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=false when main and the branch touched different files', async () => {
        repo.featureCommitted = ['other.txt'];
        repo.mainChanged = ['shared.txt'];
        const status = await computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(false);
    });

    it('flags hasForkPoint=false when origin/main has no merge-base with the branch', async () => {
        // origin/main shares no history with the branch — the "main got merged / history rewritten so
        // there is no common ancestor" case the guard forces a human to fix. `git merge-base` exits 1.
        repo.forkPoint = null;
        repo.originMain = 'orphan-sha';

        const status = await computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(false);
        expect(status.forkPoint).toBeNull();
    });
});

// THE bug the FETCH_HEAD fix is about: the DETACHED refresher's `git fetch` used to rewrite
// `.git/FETCH_HEAD` while the agent was running its own foreground fetch/pull in the same repo. That the
// installed git honours `--no-write-fetch-head` is proven in `main-sync-status.real-git.spec.ts`; here,
// that the refresh asks for exactly that, and reads the ref it refreshes.
describe('computeMainSyncStatus — must not write .git/FETCH_HEAD', () => {
    it('still refreshes the origin/main remote-tracking ref (what the status actually reads)', async () => {
        // A new commit landed on the remote's main after the last fetch.
        repo.originMain = 'stale-main-sha';
        repo.fetchedOriginMain = 'newer-main-sha';

        const status = await computeMainSyncStatus(work);

        expect(status.originMain).toBe('newer-main-sha');
        // The one fetch issued is the FETCH_HEAD-free form; the plain form only ever runs on a git too old
        // to know the flag.
        expect(feature.git.callsStartingWith(['fetch']).map((call: ProcessCallDto): string => call.commandLine))
            .toEqual(['git fetch --no-write-fetch-head origin main']);
    });
});

// Bug #1 regression: conflict detection must see WORKING-TREE changes (uncommitted / staged /
// untracked), not just committed history. Before the fix, `git diff forkPoint..HEAD` was blind to the
// files you were actively editing, so an overlap with main stayed conflict=false until you committed.
describe('computeMainSyncStatus — working-tree overlap (Bug #1)', () => {
    it('flags conflict=true for an UNCOMMITTED edit overlapping main (blind before the fix)', async () => {
        // The feature branch commits nothing over the fork point; its only change to `shared.txt`
        // (which main also changed) is an unstaged working-tree edit — the exact "invisible until
        // committed" regression. featureChangedFiles must union the working tree in.
        repo.mainChanged = ['shared.txt'];
        repo.unstaged = ['shared.txt'];
        const status = await computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=true for a STAGED edit overlapping main', async () => {
        repo.mainChanged = ['shared.txt'];
        repo.staged = ['shared.txt'];
        const status = await computeMainSyncStatus(work);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=true for an UNTRACKED new file overlapping a file main added', async () => {
        // main adds `newfile.txt` in a commit; the feature side has it only as an untracked file.
        repo.mainChanged = ['newfile.txt'];
        repo.untracked = ['newfile.txt'];
        const status = await computeMainSyncStatus(work);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('newfile.txt');
    });
});
