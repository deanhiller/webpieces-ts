import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    MainSyncStatus,
    MainSyncLock,
    readMainSyncStatus,
    writeMainSyncStatus,
    writeMainSyncLock,
    readMainSyncLock,
    tryAcquireMainSyncLock,
    isLockStale,
    isRefreshInProgress,
    inProcessLock,
    finishedLock,
    computeMainSyncStatus,
    squashRecoverySteps,
} from './main-sync-status';

function tmpRepoRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mss-'));
}

describe('main-sync lock state machine', () => {
    let root: string;
    beforeEach(() => { root = tmpRepoRoot(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('isLockStale: inprocess older than hangTimeoutMinutes is stale', () => {
        const now = 10 * 60 * 1000;
        const fresh = new MainSyncLock('inprocess', now - 2 * 60 * 1000);
        const old = new MainSyncLock('inprocess', now - 6 * 60 * 1000);
        expect(isLockStale(fresh, 5, now)).toBe(false);
        expect(isLockStale(old, 5, now)).toBe(true);
    });

    it('isRefreshInProgress: false when no lock, finished, or stale; true only for a fresh inprocess lock', () => {
        const now = 10 * 60 * 1000;
        expect(isRefreshInProgress(root, 5, now)).toBe(false); // no lock

        writeMainSyncLock(root, finishedLock(now));
        expect(isRefreshInProgress(root, 5, now)).toBe(false); // finished

        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000));
        expect(isRefreshInProgress(root, 5, now)).toBe(true); // fresh inprocess

        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 6 * 60 * 1000));
        expect(isRefreshInProgress(root, 5, now)).toBe(false); // hung → reclaimable
    });

    it('isRefreshInProgress: a fresh inprocess lock whose refresher pid is dead is reclaimable', () => {
        const now = 10 * 60 * 1000;
        // Fresh (not stale) but owned by a pid that cannot exist → a killed refresher → reclaimable
        // immediately, NOT wedged until hangTimeout.
        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, 2147483646));
        expect(isRefreshInProgress(root, 5, now)).toBe(false);
        // Fresh inprocess owned by THIS live process → genuinely in progress.
        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, process.pid));
        expect(isRefreshInProgress(root, 5, now)).toBe(true);
        // pid 0 (an old lock without a pid) → fall back to staleness only → still in progress.
        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, 0));
        expect(isRefreshInProgress(root, 5, now)).toBe(true);
    });

    it('inProcessLock/finishedLock build the expected states', () => {
        expect(inProcessLock(123).state).toBe('inprocess');
        expect(inProcessLock(123).started).toBe(123);
        expect(inProcessLock(123).pid).toBe(process.pid);
        expect(finishedLock(123).state).toBe('finished');
    });
});

// The lock's whole job is stopping two detached refreshers from running `git fetch` at once. The old
// check-then-write pair could not do that: both children passed `isRefreshInProgress` before either
// wrote. Acquisition must be ONE atomic step.
describe('main-sync lock acquisition (atomic)', () => {
    let root: string;
    beforeEach(() => { root = tmpRepoRoot(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('tryAcquireMainSyncLock: exactly ONE of two racing refreshers gets the lock', () => {
        const now = 10 * 60 * 1000;
        // Both children reach the acquire with no lock on disk — the exact window the old
        // check-then-write pair left open, in which BOTH went on to run `git fetch`.
        const first = tryAcquireMainSyncLock(root, 5, now, process.pid);
        const second = tryAcquireMainSyncLock(root, 5, now, process.pid);
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it('tryAcquireMainSyncLock: reclaims a finished, hung, or dead-pid lock', () => {
        const now = 10 * 60 * 1000;
        const deadPid = 2147483646;

        writeMainSyncLock(root, finishedLock(now - 60 * 1000));
        expect(tryAcquireMainSyncLock(root, 5, now, process.pid)).not.toBeNull();   // finished

        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 6 * 60 * 1000, 0));
        expect(tryAcquireMainSyncLock(root, 5, now, process.pid)).not.toBeNull();   // hung past timeout

        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, deadPid));
        expect(tryAcquireMainSyncLock(root, 5, now, process.pid)).not.toBeNull();   // killed refresher
    });

    it('tryAcquireMainSyncLock: records holder state/started/pid so the next caller can judge it', () => {
        const now = 10 * 60 * 1000;
        const lock = tryAcquireMainSyncLock(root, 5, now, process.pid);
        expect(lock?.state).toBe('inprocess');
        expect(lock?.started).toBe(now);
        expect(readMainSyncLock(root)?.pid).toBe(process.pid);
        expect(isRefreshInProgress(root, 5, now)).toBe(true);
    });
});

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

// Integration helpers (module scope to keep the describe callback under the method-line limit).
function git(repo: string, cmd: string): void {
    execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
}

// Build a repo whose feature branch and main both diverge from a common base, then publish main as
// origin/main (no real remote — computeMainSyncStatus only needs the ref to resolve; its `git fetch`
// is best-effort and ignored). `mainEdits`/`featureEdits` are the files each side rewrites.
//
// The whole build runs as ONE `sh` invocation instead of ~14 separate `git` spawns. A spawn costs a
// few ms on an idle machine but ~100ms once the suite runs projects in parallel, and paying that per
// test is what pushed this file past the per-test timeout under load. `set -e` keeps a failing step
// fatal, exactly as a throwing execSync did.
function buildRepo(work: string, mainEdits: string[], featureEdits: string[]): void {
    const write = (file: string, text: string): string => `printf '${text}\\n' > ${file}`;
    const steps = [
        'set -e',
        `cd ${work}`,
        'git init -q',
        'git config core.hooksPath /dev/null', // neutralize any global pre-commit hooks
        'git config user.email t@t.t',
        'git config user.name t',
        'git config commit.gpgsign false',
        write('shared.txt', 'base'),
        write('other.txt', 'base'),
        'git add -A',
        'git commit -q -m base',
        'git branch -M main',
        'git checkout -q -b feature',
    ];
    // No featureEdits => leave the feature branch even with base (used by the uncommitted/staged/
    // untracked overlap tests, where the ONLY feature-side change lives in the working tree).
    if (featureEdits.length > 0) {
        for (const f of featureEdits) steps.push(write(f, 'feature change'));
        steps.push('git add -A', 'git commit -q -m feature');
    }
    steps.push('git checkout -q main');
    for (const f of mainEdits) steps.push(write(f, 'main change'));
    steps.push(
        'git add -A',
        'git commit -q -m mainchange',
        'git update-ref refs/remotes/origin/main refs/heads/main',
        'git checkout -q feature',
    );
    execSync(steps.join('\n'), { shell: '/bin/sh', stdio: 'pipe' });
}

// A repo of a given SHAPE, built once per file and handed to each test as a plain directory copy.
// Nothing about these repos is per-test — only what the test then edits is — so rebuilding one per
// test bought nothing and cost every one of its spawns again. fs.cpSync spawns nothing at all.
const repoTemplates = new Map<string, string>();
const templateRoots: string[] = [];

function repoTemplate(mainEdits: string[], featureEdits: string[]): string {
    const key = `${mainEdits.join(',')}|${featureEdits.join(',')}`;
    const cached = repoTemplates.get(key);
    if (cached !== undefined) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-tpl-'));
    buildRepo(dir, mainEdits, featureEdits);
    repoTemplates.set(key, dir);
    templateRoots.push(dir);
    return dir;
}

// Copy a template into `work`. A git repo with no remotes holds no absolute paths, so a plain
// recursive copy is a working clone of it.
function stageRepo(work: string, mainEdits: string[], featureEdits: string[]): void {
    fs.cpSync(repoTemplate(mainEdits, featureEdits), work, { recursive: true });
}

// computeMainSyncStatus asks `gh` whether a merged/open PR tracks the branch. In a throwaway repo
// with no GitHub remote the real gh answers "no PR" — after paying process startup and, depending on
// the developer's gh state, a network round trip. A stub on PATH gives the SAME answer (non-zero =>
// no PR) instantly, so these tests neither require gh to be installed nor inherit its latency.
function stubGhOnPath(): string {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-bin-'));
    fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const previous = process.env['PATH'] ?? '';
    process.env['PATH'] = `${binDir}${path.delimiter}${previous}`;
    templateRoots.push(binDir);
    return previous;
}

// Both integration describes share the stubbed gh and the template repos; set up once for the file.
let pathBeforeStub = '';

beforeAll(() => {
    pathBeforeStub = stubGhOnPath();
});

afterAll(() => {
    process.env['PATH'] = pathBeforeStub;
    for (const dir of templateRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('computeMainSyncStatus (integration)', () => {
    let work: string;

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-work-'));
    });

    afterEach(() => {
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('records the REAL checked-out branch (not an env var)', () => {
        // Set a misleading env var: the old getCurrentBranch would have returned it; gitBranch must not.
        const prev = process.env['GIT_BRANCH'];
        process.env['GIT_BRANCH'] = 'main';
        stageRepo(work, ['other.txt'], ['shared.txt']);
        const status = computeMainSyncStatus(work);
        if (prev === undefined) delete process.env['GIT_BRANCH']; else process.env['GIT_BRANCH'] = prev;
        expect(status.branch).toBe('feature');
    });

    it('flags conflict=true when main and the branch touched the same file', () => {
        stageRepo(work, ['shared.txt'], ['shared.txt']);
        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=false when main and the branch touched different files', () => {
        stageRepo(work, ['shared.txt'], ['other.txt']);
        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(false);
    });

    it('flags hasForkPoint=false when origin/main has no merge-base with the branch', () => {
        // An orphan commit shares no history with the branch — simulates the "main got merged /
        // history rewritten so there is no common ancestor" case the guard forces a human to fix.
        stageRepo(work, ['shared.txt'], ['other.txt']);
        git(work, 'checkout --orphan orphanbranch');
        fs.writeFileSync(path.join(work, 'z.txt'), 'orphan\n');
        git(work, 'add -A');
        git(work, 'commit -m orphan');
        git(work, 'update-ref refs/remotes/origin/main refs/heads/orphanbranch');
        git(work, 'checkout feature');

        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(false);
        expect(status.forkPoint).toBeNull();
    });
});

// Does this git understand `--no-write-fetch-head` (2.29+)? On an older git the refresher knowingly
// falls back to the plain form, so the FETCH_HEAD assertion below does not apply.
function gitSupportsNoWriteFetchHead(): boolean {
    const probe = spawnSync('git', ['fetch', '--no-write-fetch-head', '--help'], { encoding: 'utf8' });
    return !(probe.stderr ?? '').toLowerCase().includes('unknown option');
}

// Build a repo with a REAL (local path) `origin`, so the refresher's network refresh actually runs.
// The no-remote template repos above cannot exercise this: their fetch fails before touching anything.
function buildRepoWithRemote(origin: string, work: string): void {
    const steps = [
        'set -e',
        `git init -q --bare -b main ${origin}`,
        `git init -q ${work}`,
        `cd ${work}`,
        'git config core.hooksPath /dev/null',
        'git config user.email t@t.t',
        'git config user.name t',
        'git config commit.gpgsign false',
        "printf 'base\\n' > shared.txt",
        'git add -A',
        'git commit -q -m base',
        'git branch -M main',
        `git remote add origin ${origin}`,
        'git push -q origin main',
        'git checkout -q -b feature',
    ];
    execSync(steps.join('\n'), { shell: '/bin/sh', stdio: 'pipe' });
}

// THE bug this file's fix is about: the DETACHED refresher's `git fetch` used to rewrite
// `.git/FETCH_HEAD` while the agent was running its own foreground fetch/pull in the same repo. The
// two unlocked writers could interleave into a duplicate `for-merge` line, and `git pull` then died
// with "Cannot fast-forward to multiple branches" — killing the very command the guards prescribe.
describe('computeMainSyncStatus — must not write .git/FETCH_HEAD', () => {
    let origin: string;
    let work: string;

    beforeEach(() => {
        origin = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-origin-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-fh-'));
        fs.rmSync(work, { recursive: true, force: true });  // git init makes it
        buildRepoWithRemote(origin, work);
    });

    afterEach(() => {
        fs.rmSync(origin, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('leaves a foreground fetch\'s FETCH_HEAD byte-for-byte untouched', () => {
        if (!gitSupportsNoWriteFetchHead()) return;
        // Stand in for the agent's foreground `git fetch origin main`: one for-merge line.
        git(work, 'fetch origin main');
        const fetchHead = path.join(work, '.git', 'FETCH_HEAD');
        const before = fs.readFileSync(fetchHead, 'utf8');
        expect(before.split('\n').filter((l: string): boolean => l.trim().length > 0)).toHaveLength(1);

        computeMainSyncStatus(work);

        expect(fs.readFileSync(fetchHead, 'utf8')).toBe(before);
    });

    it('still refreshes the origin/main remote-tracking ref (what the status actually reads)', () => {
        if (!gitSupportsNoWriteFetchHead()) return;
        // A new commit lands on the remote's main after our clone was made.
        execSync(
            ['set -e', `cd ${work}`, 'git checkout -q main', "printf 'newer\\n' > shared.txt",
                'git commit -q -am newer', 'git push -q origin main',
                'git update-ref refs/remotes/origin/main HEAD~1',  // pretend we never saw it
                'git checkout -q feature'].join('\n'),
            { shell: '/bin/sh', stdio: 'pipe' },
        );
        const remoteHead = execSync('git rev-parse main', { cwd: work, encoding: 'utf8' }).trim();

        const status = computeMainSyncStatus(work);

        expect(status.originMain).toBe(remoteHead);
        expect(fs.existsSync(path.join(work, '.git', 'FETCH_HEAD'))).toBe(false);
    });
});

// Bug #1 regression: conflict detection must see WORKING-TREE changes (uncommitted / staged /
// untracked), not just committed history. Before the fix, `git diff forkPoint..HEAD` was blind to the
// files you were actively editing, so an overlap with main stayed conflict=false until you committed.
describe('computeMainSyncStatus — working-tree overlap (Bug #1)', () => {
    let work: string;

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-wt-'));
    });

    afterEach(() => {
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('flags conflict=true for an UNCOMMITTED edit overlapping main (blind before the fix)', () => {
        // The feature branch commits nothing over the fork point; its only change to `shared.txt`
        // (which main also changed) is an unstaged working-tree edit — the exact "invisible until
        // committed" regression. featureChangedFiles must union the working tree in.
        stageRepo(work, ['shared.txt'], []);
        fs.writeFileSync(path.join(work, 'shared.txt'), 'uncommitted feature edit\n');
        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=true for a STAGED edit overlapping main', () => {
        stageRepo(work, ['shared.txt'], []);
        fs.writeFileSync(path.join(work, 'shared.txt'), 'staged feature edit\n');
        git(work, 'add shared.txt');
        const status = computeMainSyncStatus(work);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=true for an UNTRACKED new file overlapping a file main added', () => {
        // main adds `newfile.txt` in a commit; the feature side has it only as an untracked file.
        stageRepo(work, ['newfile.txt'], []);
        fs.writeFileSync(path.join(work, 'newfile.txt'), 'untracked on feature\n');
        const status = computeMainSyncStatus(work);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('newfile.txt');
    });
});
