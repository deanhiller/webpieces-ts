import { describe, it, expect, beforeEach } from 'vitest';
import {
    BranchArchiver,
    BranchReaper,
    DeletableBranch,
    ReapResult,
    ReapedBranch,
    RepoRootFinder,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_IN_USE,
} from '@webpieces/rules-config';

import { CleanupCommand } from './cleanup-command';

/**
 * The behaviour under test is the REPORT and the PROMPT — the half of wp-cleanup that decides what a
 * human is asked. Git, gh and the config loader are stubbed out; BranchReaper's own spec covers the
 * deleting, and branch-archiver.spec.ts covers the tagging against real git.
 */

// Everything the command's collaborators hand back, and everything it asked for.
class Harness {
    spared: DeletableBranch[] = [];
    reaped: ReapedBranch[] = [];
    answer = '';
    approved: DeletableBranch[] = [];
    prompts: string[] = [];
    out = '';
}

const harness = new Harness();

class FakeReaper extends BranchReaper {
    reap(): ReapResult {
        return new ReapResult(harness.reaped, [], harness.spared);
    }

    reapApproved(_repoRoot: string, _verb: 'wp-cleanup', approved: DeletableBranch[]): ReapResult {
        harness.approved = approved;
        return new ReapResult(
            approved.map((entry: DeletableBranch): ReapedBranch =>
                new ReapedBranch(entry.branch, 'sha1234567', entry.reason, entry.pr, true, '')),
            [], [],
        );
    }
}

class FakeRepoRootFinder extends RepoRootFinder {
    resolveRepoRoot(): string {
        return '/repo';
    }
}

// The command under test with the prompt seam closed over the harness's scripted answer.
class TestableCleanup extends CleanupCommand {
    protected question(prompt: string): Promise<string> {
        harness.prompts.push(prompt);
        return Promise.resolve(harness.answer);
    }
}

function build(): TestableCleanup {
    return new TestableCleanup(new FakeRepoRootFinder(), new FakeReaper(), new BranchArchiver());
}

function spared(branch: string, classification: string, commits: number, reason: string): DeletableBranch {
    return new DeletableBranch(branch, reason, 0, 'sha1234', commits, '', classification);
}

async function run(): Promise<string> {
    const original = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one run
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string): boolean => {
        harness.out += chunk;
        return true;
    };
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await build().run();
    } finally {
        (process.stdout as unknown as { write: typeof original }).write = original;
    }
    return harness.out;
}

const REAL_TTY = process.stdin.isTTY;

beforeEach(() => {
    harness.spared = [];
    harness.reaped = [];
    harness.answer = '';
    harness.approved = [];
    harness.prompts = [];
    harness.out = '';
    // The prompt path is the thing under test, so present a terminal. Restored per-test where needed.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

describe('wp-cleanup classification report (Part 5)', () => {
    /**
     * The exact regression. All three of these used to print the SAME string,
     * `no merged PR found — a human must decide`, which is why nobody ever decided.
     */
    it('gives a superseded, a never-proposed and a content-in-main branch DISTINCT output', async () => {
        harness.spared = [
            spared('feature/morpheus-gate', CLASSIFICATION_SUPERSEDED, 4, 'PR #752 was CLOSED UNMERGED and later PRs merged'),
            spared('dean/webpieces-0-3-322', CLASSIFICATION_NEVER_PROPOSED, 3, 'never had a PR; holds 3 unique commit(s)'),
            spared('dean/cherry-picked', CLASSIFICATION_CONTENT_IN_MAIN, 2, 'all 2 commit(s) already have an equivalent'),
        ];
        harness.answer = 'none';

        const out = await run();

        expect(out).toContain('SUPERSEDED');
        expect(out).toContain('NEVER PROPOSED');
        expect(out).toContain('CONTENT ALREADY IN MAIN');
        expect(out).not.toContain('a human must decide');
        // The unique-commit count is what makes the stakes legible per branch.
        expect(out).toContain('4 unique commit(s)');
        expect(out).toContain('3 unique commit(s)');
        expect(out).toContain('2 unique commit(s)');
    });

    // Safest group first, so the easy yeses come before the ones that need thought.
    it('orders the groups superseded → content-in-main → never-proposed', async () => {
        harness.spared = [
            spared('c/never', CLASSIFICATION_NEVER_PROPOSED, 1, 'r'),
            spared('a/superseded', CLASSIFICATION_SUPERSEDED, 1, 'r'),
            spared('b/in-main', CLASSIFICATION_CONTENT_IN_MAIN, 1, 'r'),
        ];
        harness.answer = 'none';

        const out = await run();

        expect(out.indexOf('a/superseded')).toBeLessThan(out.indexOf('b/in-main'));
        expect(out.indexOf('b/in-main')).toBeLessThan(out.indexOf('c/never'));
    });

    // A branch checked out somewhere is spared for a MECHANICAL reason — there is no judgement to make,
    // git would simply refuse — so asking about it would be noise.
    it('does not prompt about a branch that is merely checked out in a worktree', async () => {
        harness.spared = [spared('dean/held', CLASSIFICATION_IN_USE, 2, "checked out in worktree '/w'")];

        const out = await run();

        expect(harness.prompts).toEqual([]);
        expect(out).not.toContain('your call');
    });

    it('prints the archive tag and its restore command next to every deletion', async () => {
        const entry = new ReapedBranch('dean/merged', 'abc12345def', 'PR #430 merged', 430, true, '');
        entry.archiveTag = 'archive/2026-07-30/dean/merged';
        harness.reaped = [entry];

        const out = await run();

        expect(out).toContain('archived → archive/2026-07-30/dean/merged');
        expect(out).toContain('restore: git checkout -b dean/merged archive/2026-07-30/dean/merged');
        // The audit-log pointer is printed even on success — an undo nobody can find is not an undo.
        expect(out).toContain('branch-mutations.log');
    });
});

describe('wp-cleanup prompt — asking is the point, but silence is never a yes', () => {
    it('"all" deletes every classified branch', async () => {
        harness.spared = [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r'),
            spared('b/two', CLASSIFICATION_NEVER_PROPOSED, 2, 'r'),
        ];
        harness.answer = 'all';

        await run();

        expect(harness.approved.map((entry: DeletableBranch): string => entry.branch)).toEqual(['a/one', 'b/two']);
    });

    it('a number list deletes exactly those, by the numbers shown', async () => {
        harness.spared = [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r'),
            spared('b/two', CLASSIFICATION_CONTENT_IN_MAIN, 1, 'r'),
            spared('c/three', CLASSIFICATION_NEVER_PROPOSED, 1, 'r'),
        ];
        harness.answer = '1,3';

        await run();

        expect(harness.approved.map((entry: DeletableBranch): string => entry.branch)).toEqual(['a/one', 'c/three']);
    });

    it('the default (empty answer) deletes nothing', async () => {
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.answer = '';

        const out = await run();

        expect(harness.approved).toEqual([]);
        expect(out).toContain('Nothing deleted');
    });

    // An unparseable answer must select nothing — the fail-safe direction for a delete question.
    it('an answer that parses to nothing deletes nothing', async () => {
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.answer = 'yes please';

        await run();

        expect(harness.approved).toEqual([]);
    });

    /**
     * A prompt nobody can see must never be read as consent. This is the one place in the tooling where
     * a deletion is not backed by a proof, so a non-interactive shell answers NONE and says so.
     */
    it('deletes nothing and does not prompt when there is no TTY', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.answer = 'all';

        const out = await run();

        expect(harness.prompts).toEqual([]);
        expect(harness.approved).toEqual([]);
        expect(out).toContain('Not a terminal');
        Object.defineProperty(process.stdin, 'isTTY', { value: REAL_TTY, configurable: true });
    });
});
