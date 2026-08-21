import { describe, it, expect, beforeEach } from 'vitest';
import {
    BranchArchiver,
    BranchReaper,
    DeletableBranch,
    DeletableWorktree,
    MergedBranchesService,
    ReapResult,
    ReapedBranch,
    ReapedWorktree,
    RepoRootFinder,
    WorktreeReapResult,
    WorktreeReaper,
    WorktreeService,
    CliExitError,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_NO_COMMITS,
    CLASSIFICATION_IN_USE,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_CURRENT,
    CLASSIFICATION_LOCKED,
} from '@webpieces/rules-config';

import { CleanupCommand } from './cleanup-command';
import { WorktreeCleanupSection } from './worktree-cleanup';
import {
    CleanupOptions,
    DeleteSelection,
    FLAG_DELETE_BRANCHES,
    FLAG_DELETE_WORKTREES,
} from './cleanup-options';

/**
 * The behaviour under test is the REPORT and the PROMPT — the half of wp-cleanup that decides what a
 * human is asked. Git, gh and the config loader are stubbed out; BranchReaper's own spec covers the
 * deleting, and branch-archiver.spec.ts covers the tagging against real git.
 */

// Everything the command's collaborators hand back, and everything it asked for.
class Harness {
    spared: DeletableBranch[] = [];
    reaped: ReapedBranch[] = [];
    // Branches a CONCURRENT reaper took before this pass reached them (the auto-reap race).
    alreadyGone: ReapedBranch[] = [];
    answer = '';
    approved: DeletableBranch[] = [];
    prompts: string[] = [];
    out = '';
    // The worktree half: the verdicts the section hands back, and every target it was asked to reap.
    worktrees: DeletableWorktree[] = [];
    worktreeTargets: DeletableWorktree[] = [];
    // Set when the (fake) worktree reap removed something, so the branch pass can model the world it
    // leaves behind: a branch spared only by that worktree is reapable once the worktree is gone.
    branchesFreedByWorktreeReap: string[] = [];
    // Worktree paths `git status --porcelain` would report as dirty — the one thing that spares a
    // zero-commit worktree from the husk reap.
    dirtyWorktrees: string[] = [];
    // Everything reapApproved was handed, across every call in one run (husks AND the chosen ones).
    approvedAll: DeletableBranch[] = [];
    // What argv said for this run.
    options: CleanupOptions = noFlags();
}

const harness = new Harness();

class FakeReaper extends BranchReaper {
    reap(): ReapResult {
        // The branch pass runs AFTER the worktree pass and recomputes from scratch, so a branch whose
        // only jailer was a now-removed worktree is no longer spared — it is reaped.
        const freed = new Set(harness.branchesFreedByWorktreeReap);
        const spared = harness.spared.filter(
            (entry: DeletableBranch): boolean => !freed.has(entry.branch));
        const reaped = [...harness.reaped, ...harness.spared
            .filter((entry: DeletableBranch): boolean => freed.has(entry.branch))
            .map((entry: DeletableBranch): ReapedBranch =>
                new ReapedBranch(entry.branch, 'sha1234567', 'PR merged (its worktree was just removed)',
                    entry.pr, true, ''))];
        return new ReapResult(reaped, [], spared, harness.alreadyGone);
    }

    reapApproved(_repoRoot: string, _verb: 'wp-cleanup', approved: DeletableBranch[]): ReapResult {
        harness.approved = approved;
        harness.approvedAll = [...harness.approvedAll, ...approved];
        return new ReapResult(
            approved.map((entry: DeletableBranch): ReapedBranch =>
                new ReapedBranch(entry.branch, 'sha1234567', entry.reason, entry.pr, true, '')),
            [], [],
        );
    }
}

// The worktree section with git replaced: `verdicts` hands back the scripted list, and `reap` records
// what it was asked to remove and reports it removed. WorktreeReaper's own spec covers the real thing.
class FakeWorktreeSection extends WorktreeCleanupSection {
    verdicts(): DeletableWorktree[] {
        return harness.worktrees;
    }

    protected hasUncommittedChanges(worktreePath: string): boolean {
        return harness.dirtyWorktrees.includes(worktreePath);
    }

    reap(_repoRoot: string, _verb: 'wp-cleanup', targets: DeletableWorktree[]): WorktreeReapResult {
        harness.worktreeTargets = [...harness.worktreeTargets, ...targets];
        return new WorktreeReapResult(
            targets.map((tree: DeletableWorktree): ReapedWorktree => {
                const done = new ReapedWorktree(tree.path, tree.branch, 'sha99', tree.reason, tree.pr, true, '');
                done.branchDeleted = true;
                return done;
            }),
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
    return new TestableCleanup(
        new FakeRepoRootFinder(), new FakeReaper(), new BranchArchiver(),
        new FakeWorktreeSection(new MergedBranchesService(), new WorktreeReaper(), new WorktreeService()));
}

// Argv said nothing — the bare `pnpm wp-cleanup` every test starts from.
function noFlags(): CleanupOptions {
    return new CleanupOptions(
        new DeleteSelection(FLAG_DELETE_BRANCHES, false, ''),
        new DeleteSelection(FLAG_DELETE_WORKTREES, false, ''),
        false, false);
}

function branchFlag(value: string): CleanupOptions {
    return new CleanupOptions(
        new DeleteSelection(FLAG_DELETE_BRANCHES, true, value),
        new DeleteSelection(FLAG_DELETE_WORKTREES, false, ''),
        false, false);
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
        await build().run(harness.options);
    } finally {
        (process.stdout as unknown as { write: typeof original }).write = original;
    }
    return harness.out;
}

const REAL_TTY = process.stdin.isTTY;

beforeEach(() => {
    harness.spared = [];
    harness.reaped = [];
    harness.alreadyGone = [];
    harness.answer = '';
    harness.approved = [];
    harness.prompts = [];
    harness.out = '';
    harness.worktrees = [];
    harness.worktreeTargets = [];
    harness.branchesFreedByWorktreeReap = [];
    harness.dirtyWorktrees = [];
    harness.approvedAll = [];
    harness.options = noFlags();
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
            spared('feature/checklist-gate', CLASSIFICATION_SUPERSEDED, 4, 'PR #752 was CLOSED UNMERGED and later PRs merged'),
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

    /**
     * The auto-reap race, as the human sees it. wp-cleanup and the detached refresher's auto-reap
     * both act on their own fresh verdicts and are started by the same commands, so they race by
     * design. When the refresher wins, this pass finds nothing to archive or delete — and used to
     * report that under "⚠️ N branch(es) could not be deleted", which reads as work left undone
     * about branches that no longer exist. It is an outcome, not a warning.
     */
    it('reports concurrently-reaped branches as already gone, not as failures', async () => {
        const gone = new ReapedBranch('dean/merged', '', 'PR #586 merged', 586, false, 'already gone');
        gone.alreadyGone = true;
        harness.alreadyGone = [gone];

        const out = await run();

        expect(out).toContain('already gone');
        expect(out).toContain('dean/merged');
        expect(out).not.toContain('could not be deleted');
        expect(out).not.toContain('⚠️');
        // And it is NOT the "nothing to clean up" case either — something did happen to that branch.
        expect(out).not.toContain('Nothing to clean up');
    });
});

describe('wp-cleanup worktree reaping (the half that never ran)', () => {
    // The provably-dead worktrees go without being asked about — same posture as a merged branch.
    it('auto-removes a provably dead worktree and reports the restore command', async () => {
        harness.worktrees = [new DeletableWorktree(
            '/work/wt-merged', 'dean/merged', 'PR #430 merged', 430, true, CLASSIFICATION_MERGED_PR)];

        const out = await run();

        expect(harness.worktreeTargets.map((tree: DeletableWorktree): string => tree.path))
            .toEqual(['/work/wt-merged']);
        expect(out).toContain('Removed 1 dead worktree(s)');
        expect(out).toContain('/work/wt-merged');
        expect(out).toContain('restore: git worktree add');
        expect(out).toContain('REAP_WORKTREE');
    });

    /**
     * THE DEADLOCK, end to end. `dean/held` is spared only because a worktree holds it. The worktree
     * pass runs FIRST, removes that worktree, and the branch pass — which recomputes — then reaps the
     * branch. Before this change both survived every cleanup, forever.
     */
    it('makes a branch spared only by a dead worktree reapable', async () => {
        harness.worktrees = [new DeletableWorktree(
            '/work/wt-merged', 'dean/held', 'PR #430 merged', 430, true, CLASSIFICATION_MERGED_PR)];
        harness.spared = [spared(
            'dean/held', CLASSIFICATION_IN_USE, 2,
            "checked out in worktree '/work/wt-merged' — remove that worktree before deleting the branch")];
        harness.branchesFreedByWorktreeReap = ['dean/held'];

        const out = await run();

        expect(out.indexOf('Removed 1 dead worktree(s)')).toBeLessThan(out.indexOf('Cleaned up'));
        expect(out).toContain('✓ dean/held');
        expect(harness.prompts).toEqual([]);
    });

    // The worktree the command is running in is never a target — merged-branches never marks it
    // deletable, and WorktreeReaper refuses it a second time regardless of what it is handed.
    it('never offers the worktree it is standing in', async () => {
        harness.worktrees = [new DeletableWorktree(
            '/repo', 'dean/here', 'you are standing in it', 0, false, CLASSIFICATION_CURRENT)];

        const out = await run();

        expect(harness.worktreeTargets).toEqual([]);
        expect(harness.prompts).toEqual([]);
        expect(out).toContain('Worktrees deliberately left alone');
        expect(out).toContain('you are standing in it');
    });

});

// The worktree PROMPT — same posture as the branch prompt, because it is the same verdict on the same
// branch: nothing in this group is removed without an explicit typed answer.
describe('wp-cleanup worktree prompt', () => {
    // Probably-dead worktrees are ASKED about, exactly like probably-dead branches — and the answer is
    // per-number, so "remove that one but not that one" is expressible.
    it('prompts about a probably-dead worktree and removes only the chosen one', async () => {
        harness.worktrees = [
            new DeletableWorktree('/work/a', 'dean/a', 'PR #1 CLOSED UNMERGED', 1, false, CLASSIFICATION_SUPERSEDED),
            new DeletableWorktree('/work/b', 'dean/b', 'never had a PR', 0, false, CLASSIFICATION_NEVER_PROPOSED),
        ];
        harness.answer = '1';

        const out = await run();

        expect(out).toContain('worktree(s) are probably dead');
        expect(harness.worktreeTargets.map((tree: DeletableWorktree): string => tree.path)).toEqual(['/work/a']);
    });

    /**
     * The non-TTY worktree half, after the change: it removes NOTHING from the numbered block and
     * hands back the exact command that would. It used to silently take the "redundant" ones, which
     * both hid the decision and renumbered the list it had just printed.
     */
    it('takes no worktree from the block with no TTY, and prints the command that would', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        harness.worktrees = [
            new DeletableWorktree('/work/a', 'dean/a', 'PR #1 CLOSED UNMERGED', 1, false, CLASSIFICATION_SUPERSEDED),
            new DeletableWorktree('/work/b', 'dean/b', 'never had a PR', 0, false, CLASSIFICATION_NEVER_PROPOSED),
        ];
        harness.answer = 'all';

        const out = await run();

        expect(harness.worktreeTargets).toEqual([]);
        expect(harness.prompts).toEqual([]);
        // The identical numbered block a human sees, plus how to act on it.
        expect(out).toContain('[1] /work/a');
        expect(out).toContain('[2] /work/b');
        expect(out).toContain(`pnpm wp-cleanup ${FLAG_DELETE_WORKTREES}=all`);
        expect(out).toContain(`pnpm wp-cleanup ${FLAG_DELETE_WORKTREES}=1,3`);
        Object.defineProperty(process.stdin, 'isTTY', { value: REAL_TTY, configurable: true });
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
        expect(out).toContain('were kept');
    });

    // An unparseable answer must select nothing — the fail-safe direction for a delete question.
    it('an answer that parses to nothing deletes nothing', async () => {
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.answer = 'yes please';

        await run();

        expect(harness.approved).toEqual([]);
    });

    /**
     * The AGENT path, and the whole point of this command being runnable by one.
     *
     * It reaps the zero-commit husk without being asked (that is Part 1), takes NOTHING out of the
     * numbered block, and prints the block plus the exact command that takes it. Taking part of the
     * block silently is what it used to do, and it is what made `--delete-branches=3,4` unsafe: the
     * numbers it printed no longer pointed at the same refs on the next run.
     */
    it('reaps the husk, takes nothing from the block, and prints the command that would (no TTY)', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        harness.spared = [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r'),
            spared('b/two', CLASSIFICATION_CONTENT_IN_MAIN, 1, 'r'),
            spared('c/three', CLASSIFICATION_NO_COMMITS, 0, 'r'),
            spared('d/four', CLASSIFICATION_NEVER_PROPOSED, 3, 'r'),
        ];
        harness.answer = 'all';

        const out = await run();

        expect(harness.prompts).toEqual([]);
        // Only the zero-commit husk, and it was never in the numbered block.
        expect(harness.approvedAll.map((entry: DeletableBranch): string => entry.branch)).toEqual(['c/three']);
        expect(out).toContain('zero-commit branches');
        expect(out).toContain('[1] a/one');
        expect(out).toContain('[2] b/two');
        expect(out).toContain('[3] d/four');
        expect(out).not.toContain('[4] ');
        expect(out).toContain(`pnpm wp-cleanup ${FLAG_DELETE_BRANCHES}=all`);
        Object.defineProperty(process.stdin, 'isTTY', { value: REAL_TTY, configurable: true });
    });
});

/**
 * PART 1 — a ref with zero unique commits is a HUSK, and a husk is reaped on sight.
 *
 * Dean, after a terminal run stopped to ask him about two branches identical to origin/main: "this is
 * really dumb ... wp-cleanup should just reap if no commits and no agents working ... we can make
 * mistakes - we want SPEED". Deleting such a ref loses a NAME, not a commit, and the name is archived
 * to a tag first — so the only thing worth checking is whether somebody is HOLDING it.
 */
describe('wp-cleanup zero-commit husks are reaped by default', () => {
    it('reaps a zero-commit branch in a terminal with no prompt at all', async () => {
        harness.spared = [spared('dean/investigate-home-config-deadlock', CLASSIFICATION_NO_COMMITS, 0,
            'no commits of its own — identical to origin/main')];

        const out = await run();

        expect(harness.prompts).toEqual([]);
        expect(harness.approvedAll.map((entry: DeletableBranch): string => entry.branch))
            .toEqual(['dean/investigate-home-config-deadlock']);
        expect(out).toContain('zero-commit branches');
        expect(out).not.toContain('your call');
    });

    // PART 2: the husk reap is archived like every other delete, and says how to undo it.
    it('archives the husk and prints the recover pointer', async () => {
        harness.spared = [spared('worktree-agent-a10a638a', CLASSIFICATION_NO_COMMITS, 0, 'identical to origin/main')];

        const out = await run();

        expect(out).toContain('archived to a tag first');
        expect(out).toContain('branch-mutations.log');
    });

    // A branch classified NEVER PROPOSED that nonetheless holds zero unique commits is the same husk.
    // The verdict token is not the evidence here; the commit count is.
    it('treats a zero-unique-commit branch as a husk whatever its classification says', async () => {
        harness.spared = [spared('dean/parked', CLASSIFICATION_NEVER_PROPOSED, 0, 'never had a PR')];

        const out = await run();

        expect(harness.approvedAll.map((entry: DeletableBranch): string => entry.branch)).toEqual(['dean/parked']);
        expect(out).not.toContain('your call');
    });

    it('reaps a zero-commit worktree with no prompt', async () => {
        harness.worktrees = [new DeletableWorktree(
            '/work/wt-husk', 'worktree-agent-b', 'identical to origin/main', 0, false, CLASSIFICATION_NO_COMMITS)];

        const out = await run();

        expect(harness.worktreeTargets.map((tree: DeletableWorktree): string => tree.path))
            .toEqual(['/work/wt-husk']);
        expect(harness.prompts).toEqual([]);
        expect(out).toContain('zero-commit worktrees');
    });

    /**
     * THE ONE CASE THE CAUTION EXISTED FOR. A worktree with uncommitted or untracked files looks
     * exactly like a husk by its ref, and holds work no archive tag can bring back.
     */
    it('spares a zero-commit worktree that holds uncommitted work, and says why', async () => {
        harness.worktrees = [new DeletableWorktree(
            '/work/wt-live', 'worktree-agent-c', 'identical to origin/main', 0, false, CLASSIFICATION_NO_COMMITS)];
        harness.dirtyWorktrees = ['/work/wt-live'];

        const out = await run();

        expect(harness.worktreeTargets).toEqual([]);
        expect(out).toContain('SPARED because work is in flight');
        expect(out).toContain('/work/wt-live');
        expect(out).toContain('uncommitted or untracked files');
    });

    // A live lock never even reaches the husk pass — merged-branches classifies it LOCKED, which is
    // not promptable. Asserted here so the guarantee is pinned from wp-cleanup's side too.
    it('never touches a live-locked worktree, whatever its commit count', async () => {
        harness.worktrees = [new DeletableWorktree(
            '/work/wt-locked', 'worktree-agent-d', 'locked by claude agent pid 4242 (still running)', 0, false,
            CLASSIFICATION_LOCKED)];

        const out = await run();

        expect(harness.worktreeTargets).toEqual([]);
        expect(harness.prompts).toEqual([]);
        expect(out).toContain('Worktrees deliberately left alone');
        expect(out).toContain('still running');
    });
});

/**
 * PART 4 — the flags. An explicit flag is a caller who KNOWS, and it beats `process.stdin.isTTY`,
 * which was only ever a guess about who was standing there.
 */
describe('wp-cleanup flags', () => {
    it('--delete-branches=all deletes the whole classified block with no prompt, tty or not', async () => {
        harness.spared = [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r'),
            spared('b/two', CLASSIFICATION_NEVER_PROPOSED, 2, 'r'),
        ];
        harness.options = branchFlag('all');

        await run();

        expect(harness.prompts).toEqual([]);
        expect(harness.approved.map((entry: DeletableBranch): string => entry.branch)).toEqual(['a/one', 'b/two']);
    });

    it('--delete-branches=1,3 deletes exactly the numbers printed', async () => {
        harness.spared = [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r'),
            spared('b/two', CLASSIFICATION_CONTENT_IN_MAIN, 1, 'r'),
            spared('c/three', CLASSIFICATION_NEVER_PROPOSED, 1, 'r'),
        ];
        harness.options = branchFlag('1,3');

        const out = await run();

        expect(harness.approved.map((entry: DeletableBranch): string => entry.branch)).toEqual(['a/one', 'c/three']);
        // The numbering the flag acted on is the numbering that was printed.
        expect(out.indexOf('[1] a/one')).toBeGreaterThan(-1);
        expect(out.indexOf('[3] c/three')).toBeGreaterThan(-1);
    });

    // AN EXPLICIT FLAG BEATS THE TTY SNIFF: a terminal is present and no prompt is issued.
    it('--delete-branches=none beats a live tty and asks nothing', async () => {
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.answer = 'all';
        harness.options = branchFlag('none');

        await run();

        expect(harness.prompts).toEqual([]);
        expect(harness.approved).toEqual([]);
    });

    it('--delete-worktrees=all removes the whole worktree block', async () => {
        harness.worktrees = [
            new DeletableWorktree('/work/a', 'dean/a', 'PR #1 CLOSED UNMERGED', 1, false, CLASSIFICATION_SUPERSEDED),
            new DeletableWorktree('/work/b', 'dean/b', 'never had a PR', 0, false, CLASSIFICATION_NEVER_PROPOSED),
        ];
        harness.options = new CleanupOptions(
            new DeleteSelection(FLAG_DELETE_BRANCHES, false, ''),
            new DeleteSelection(FLAG_DELETE_WORKTREES, true, 'all'), false, false);

        await run();

        expect(harness.prompts).toEqual([]);
        expect(harness.worktreeTargets.map((tree: DeletableWorktree): string => tree.path))
            .toEqual(['/work/a', '/work/b']);
    });

    // --interactive is the mirror image: no tty, and it prompts anyway.
    it('--interactive prompts with no tty', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.answer = 'all';
        harness.options = new CleanupOptions(
            new DeleteSelection(FLAG_DELETE_BRANCHES, false, ''),
            new DeleteSelection(FLAG_DELETE_WORKTREES, false, ''), false, true);

        await run();

        expect(harness.prompts.length).toEqual(1);
        expect(harness.approved.map((entry: DeletableBranch): string => entry.branch)).toEqual(['a/one']);
        Object.defineProperty(process.stdin, 'isTTY', { value: REAL_TTY, configurable: true });
    });

    /**
     * --report is the print-and-exit case, and the ONLY run whose numbers are still valid when the
     * next command starts — because a run that deletes nothing cannot renumber anything.
     */
    it('--report deletes nothing at all, husks included', async () => {
        harness.spared = [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 2, 'r'),
            spared('c/husk', CLASSIFICATION_NO_COMMITS, 0, 'r'),
        ];
        harness.worktrees = [new DeletableWorktree(
            '/work/wt-merged', 'dean/merged', 'PR #430 merged', 430, true, CLASSIFICATION_MERGED_PR)];
        harness.options = new CleanupOptions(
            new DeleteSelection(FLAG_DELETE_BRANCHES, false, ''),
            new DeleteSelection(FLAG_DELETE_WORKTREES, false, ''), true, false);

        const out = await run();

        expect(harness.approvedAll).toEqual([]);
        expect(harness.worktreeTargets).toEqual([]);
        expect(harness.prompts).toEqual([]);
        expect(out).toContain('nothing will be deleted');
        expect(out).toContain('Would reap');
        expect(out).toContain('c/husk');
        expect(out).toContain('[1] a/one');
    });

    /**
     * THE NUMBERING CONTRACT, asserted end to end: what `--report` numbers is what
     * `--delete-branches=<n>` acts on. A husk reaped in between must not shift a single index, which
     * is exactly why husks are never IN the block.
     */
    it('numbers the report and the flag identically, with a husk reaped in between', async () => {
        const branches = (): DeletableBranch[] => [
            spared('a/one', CLASSIFICATION_SUPERSEDED, 2, 'r'),
            spared('c/husk', CLASSIFICATION_NO_COMMITS, 0, 'r'),
            spared('b/two', CLASSIFICATION_NEVER_PROPOSED, 5, 'r'),
        ];

        harness.spared = branches();
        harness.options = new CleanupOptions(
            new DeleteSelection(FLAG_DELETE_BRANCHES, false, ''),
            new DeleteSelection(FLAG_DELETE_WORKTREES, false, ''), true, false);
        const report = await run();

        expect(report).toContain('[1] a/one');
        expect(report).toContain('[2] b/two');

        harness.out = '';
        harness.approvedAll = [];
        harness.spared = branches();
        harness.options = branchFlag('2');
        await run();

        // '2' is b/two in BOTH runs — the husk it reaped on the second run did not renumber anything.
        expect(harness.approved.map((entry: DeletableBranch): string => entry.branch)).toEqual(['b/two']);
        expect(harness.approvedAll.map((entry: DeletableBranch): string => entry.branch))
            .toEqual(['c/husk', 'b/two']);
    });

    // A number past the end of the block means the caller is holding numbers from an older run. That
    // is the one way this command can delete the wrong ref, so it stops rather than guessing.
    it('refuses a number that is not in the block it just printed', async () => {
        harness.spared = [spared('a/one', CLASSIFICATION_SUPERSEDED, 1, 'r')];
        harness.options = branchFlag('1,4');

        await expect(run()).rejects.toThrow(CliExitError);
        expect(harness.approved).toEqual([]);
    });

    // A bare run with nothing to do points at --help rather than saying nothing useful.
    it('points a bare run with nothing to do at --help', async () => {
        const out = await run();

        expect(out).toContain('--help');
    });
});
