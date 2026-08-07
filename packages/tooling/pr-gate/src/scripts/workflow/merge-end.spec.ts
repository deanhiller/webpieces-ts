import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgedTreeSweeper, RepoRootFinder } from '@webpieces/rules-config';
import { MergeEnd, MergeEndOptions } from './merge-end';
import { MergeContext } from './merge-start';
import { MergeState } from './merge-state';
import { BranchNaming } from './branch-naming';
import { CleanTmp } from './cleanTmp';
import { GitExec } from './git-exec';

// A GitExec that records the git commands finalize would have run, instead of running them.
class FakeGitExec extends GitExec {
    calls: string[][] = [];

    constructor() {
        super(new RepoRootFinder());
    }

    override runGitChecked(args: string[]): void {
        this.calls.push(args);
    }
}

// MergeEnd with its two git-probing seams canned. `pushFinalized` records rather than pushes so the
// test asserts on WHETHER a push was attempted, which is the whole invariant here.
class TestMergeEnd extends MergeEnd {
    pushAttempts = 0;

    constructor(private readonly fakeGit: FakeGitExec, private readonly backupExists: boolean) {
        super(
            new BranchNaming(),
            // One root only: `{repo}/.webpieces`. There is no machine-global state left to sweep.
            new CleanTmp(new RepoRootFinder(), new AgedTreeSweeper()),
            fakeGit,
            new MergeState());
    }

    protected override pushFinalized(): boolean {
        this.pushAttempts++;
        return true;
    }

    protected override localBranchExists(name: string): boolean {
        return name.includes('PreMerge') ? this.backupExists : false;
    }
}

let repoRoot = '';

beforeEach((): void => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-merge-end-'));
});

afterEach((): void => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
});

const ctx = (): MergeContext => new MergeContext('dean/feat', 'dean/featSquash', 'dean/featPreMerge1', '7');

const finalize = async (pushRemote: boolean, backupExists: boolean = true): Promise<[TestMergeEnd, FakeGitExec]> => {
    const git = new FakeGitExec();
    const mergeEnd = new TestMergeEnd(git, backupExists);
    // conflictedFiles null => clean merge, finalize only (no validation path, no marker on disk).
    await mergeEnd.mergeEnd(repoRoot, 'wp-start-upsert-pr', repoRoot, ctx(), new MergeEndOptions(null, pushRemote));
    return [mergeEnd, git];
};

// Every git command flattened, for asserting what was and was NOT run.
const flat = (git: FakeGitExec): string[] => git.calls.map((c: string[]): string => c.join(' '));

describe('pushRemote=false — the PR flow, where wp-finish-upsert-pr owns the single push', () => {
    it('does not push', async (): Promise<void> => {
        const [mergeEnd, git] = await finalize(false);
        expect(mergeEnd.pushAttempts).toBe(0);
        expect(flat(git).some((c: string): boolean => c.startsWith('push'))).toBe(false);
    });

    it('KEEPS the pre-merge snapshot — an unpushed squash rewrite must exist somewhere other than HEAD', async (): Promise<void> => {
        const [, git] = await finalize(false);
        expect(flat(git)).not.toContain('branch -D dean/featPreMerge1');
    });

    it('still finalizes the branch swap (delete old, checkout squash, rename to the feature name)', async (): Promise<void> => {
        const [, git] = await finalize(false);
        expect(flat(git)).toContain('branch -D dean/feat');
        expect(flat(git)).toContain('checkout dean/featSquash');
        expect(flat(git)).toContain('branch -m dean/feat');
    });
});

describe('pushRemote=true — the update-only flow, where finalizing IS the end', () => {
    it('pushes', async (): Promise<void> => {
        const [mergeEnd] = await finalize(true);
        expect(mergeEnd.pushAttempts).toBe(1);
    });

    it('deletes the pre-merge snapshot on a clean merge — origin now has the result, so it is disposable', async (): Promise<void> => {
        const [, git] = await finalize(true);
        expect(flat(git)).toContain('branch -D dean/featPreMerge1');
    });

    it('does not try to delete a snapshot that is not there', async (): Promise<void> => {
        const [, git] = await finalize(true, false);
        expect(flat(git)).not.toContain('branch -D dean/featPreMerge1');
    });
});
