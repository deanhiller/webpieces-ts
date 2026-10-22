import { describe, it, expect, beforeEach } from 'vitest';
import { GitResultDto, ProcessResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';

import { WorkflowFeature } from './__tests__/workflow-feature';
import { MergedBranchesService } from './merged-branches';
import { DeletableBranch, CLASSIFICATION_MERGED_PR, CLASSIFICATION_BACKUP_OF_MERGED, CLASSIFICATION_BACKUP_OF_LIVE, CLASSIFICATION_NO_COMMITS, CLASSIFICATION_SUPERSEDED, CLASSIFICATION_CONTENT_IN_MAIN, CLASSIFICATION_NEVER_PROPOSED, CLASSIFICATION_PRUNABLE, CLASSIFICATION_LOCKED, CLASSIFICATION_CURRENT, ADJUDICATED_CLASSIFICATIONS, MergedBranchesCache, DeletableWorktree } from './merged-branch-verdicts';

/** One PR as `gh pr list --json` reports it. Data only. */
class PrRow {
    constructor(readonly number: number, readonly headRefName: string, readonly state: string = 'MERGED') {}
}

/** One LINKED worktree (the primary clone, at /repo on `currentBranch`, is synthesised below). Data only. */
class TreeRow {
    constructor(readonly path: string, readonly branch: string, readonly extra: string = '') {}
}

/**
 * The outside world this suite's scenarios describe: what `gh` and `git` know. The mocked process
 * edges answer every call FROM it (#1381) — no git or gh process is started.
 */
class World {
    // What `gh pr list --state merged` returns.
    mergedPrs: { number: number; headRefName: string }[] = [];
    // `gh pr list --state all` — every PR with its state, the DISPLAY-only lookup main added in #509.
    // Our `superseded` signal reads CLOSED entries off this same call rather than adding a third one.
    allPrs: { number: number; headRefName: string; state: string }[] = [];
    // Branch → what `git cherry origin/main <branch>` prints. A `- <sha>` line means an equivalent
    // change is ALREADY upstream; `+ <sha>` means it is not.
    cherry: Record<string, string> = {};
    localBranches: string[] = [];
    currentBranch = 'main';
    ghOk = true;
    // Commits each branch has that origin/main does not. Anything absent is assumed to have work.
    commitsAhead: Record<string, number> = {};
    worktrees: { path: string; branch: string; extra?: string }[] = [];

    gh(call: ProcessCallDto): ProcessResultDto {
        if (!this.ghOk) return new ProcessResultDto(1, '', 'gh: not authenticated');
        const state = call.args[call.args.indexOf('--state') + 1];
        const rows = state === 'all'
            ? this.allPrs.map((pr: { number: number; headRefName: string; state: string }): PrRow =>
                new PrRow(pr.number, pr.headRefName, pr.state))
            : this.mergedPrs.map((pr: { number: number; headRefName: string }): PrRow => new PrRow(pr.number, pr.headRefName));
        return new ProcessResultDto(0, JSON.stringify(rows), '');
    }

    git(call: ProcessCallDto): GitResultDto {
        const args = call.args;
        if (args[0] === 'rev-parse') return new GitResultDto(0, `sha-${String(args[args.length - 1])}`, '');
        if (args[0] === 'cherry') {
            const listing = this.cherry[String(args[2])];
            return listing === undefined ? new GitResultDto(1, '', '') : new GitResultDto(0, listing, '');
        }
        // `git show-ref --verify --quiet refs/heads/<branch>` — exit 0 only when that BRANCH exists.
        // This is how a snapshot proves its base is still around and therefore still holds the work.
        if (args[0] === 'show-ref') {
            const ref = String(args[args.length - 1]).replace('refs/heads/', '');
            return new GitResultDto(this.localBranches.includes(ref) ? 0 : 1, '', '');
        }
        if (args[0] === 'for-each-ref') return new GitResultDto(0, this.localBranches.join('\n') + '\n', '');
        if (args[0] === 'worktree') return new GitResultDto(0, this.porcelain(), '');
        if (args[0] === 'rev-list') {
            const branch = String(args[2]).replace('origin/main..', '');
            return new GitResultDto(0, String(this.commitsAhead[branch] ?? 1), '');
        }
        return new GitResultDto(1, '', '');
    }

    private porcelain(): string {
        let out = `worktree /repo\nHEAD aaa\nbranch refs/heads/${this.currentBranch}\n`;
        for (const tree of this.worktrees) {
            const row = new TreeRow(tree.path, tree.branch, tree.extra ?? '');
            out += `\nworktree ${row.path}\nHEAD bbb\nbranch refs/heads/${row.branch}\n`;
            if (row.extra !== '') out += `${row.extra}\n`;
        }
        return out;
    }
}

function names(list: DeletableBranch[]): string[] {
    return list.map((entry: DeletableBranch): string => entry.branch).sort();
}

let world: World;
let svc: MergedBranchesService;

beforeEach(async () => {
    world = new World();
    const feature = await WorkflowFeature.create();
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => world.git(call));
    feature.processes.respondToPrefix('gh', [], (call: ProcessCallDto): ProcessResultDto => world.gh(call));
    svc = feature.container.get(MergedBranchesService);
});

describe('MergedBranchesService.computeMergedBranches', () => {
    it('marks a branch deletable when its own PR is merged, and spares one with no PR', async () => {
        world.mergedPrs = [{ number: 188, headRefName: 'dean/config-overhaul' }];
        world.localBranches = ['main', 'dean/config-overhaul', 'dean/still-working'];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(names(cache.deletable)).toEqual(['dean/config-overhaul']);
        expect(cache.deletable[0].pr).toBe(188);
        expect(cache.deletable[0].reason).toContain('PR #188 merged');
        expect(names(cache.keep)).toEqual(['dean/still-working']);
    });

    /**
     * The squash-merge tool's backup branches (base → baseSquash / basewp2 / basePreMerge3) exist only
     * locally — GitHub has never seen their SHAs, so no PR will ever name them. They are reapable only
     * by stripping back to the base branch. Without this, the branch cap is unreachable: in the repo
     * that motivated this, 6 of 22 dead branches were backups.
     */
    it('reaps squash-merge backups once the branch they back up has merged', async () => {
        world.mergedPrs = [{ number: 332, headRefName: 'dean/http-client' }];
        world.localBranches = [
            'main',
            'dean/http-client',
            'dean/http-clientPreMerge2',
            'dean/http-clientwp3',
            'dean/http-clientSquash',
        ];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(names(cache.deletable)).toEqual([
            'dean/http-client',
            'dean/http-clientPreMerge2',
            'dean/http-clientSquash',
            'dean/http-clientwp3',
        ]);
        expect(cache.keep.length).toBe(0);
        const backup = cache.deletable.find((d: DeletableBranch): boolean => d.branch === 'dean/http-clientwp3');
        expect(backup?.reason).toContain("backup of 'dean/http-client'");
        expect(backup?.pr).toBe(332);
    });

    it('spares a backup whose base branch has NOT merged', async () => {
        world.mergedPrs = [];
        world.localBranches = ['main', 'dean/in-flightwp2'];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/in-flightwp2']);
    });
});

describe('MergedBranchesService empty-branch husks', () => {
    /**
     * "Zero commits of its own" is NOT a proof of death and must never auto-reap.
     *
     * It reads as "holds no work", and for a bare ref that is true — but it is equally the state of
     * every branch created by `git worktree add -b … origin/main` from creation until its first
     * commit, i.e. exactly the window in which an agent is working in it. Observed 2026-07-30: three
     * worktrees with live agents were listed as dead under this rule, with the words "so no work can
     * be lost". These verdicts answer "is it PROVABLY dead?", and a husk is not — so it lands in
     * `keep` as CLASSIFICATION_NO_COMMITS. wp-cleanup then reaps it, but only after checking the
     * worktree on disk for the thing this service cannot see: uncommitted files, a live lock, the
     * tree you are standing in. The check is what stands where the 2026-07-30 auto-delete stood.
     */
    it('SPARES a branch with no commits of its own — it may be a worktree in active use', async () => {
        world.localBranches = ['main', 'dean/never-committed'];
        world.commitsAhead = { 'dean/never-committed': 0 };

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.deletable).toEqual([]);
        expect(names(cache.keep)).toEqual(['dean/never-committed']);
        expect(cache.keep[0].classification).toBe(CLASSIFICATION_NO_COMMITS);
        expect(cache.keep[0].reason).toContain('working in');
    });

    // …and it reaches wp-cleanup's adjudicated set rather than being dropped on the floor, which is
    // what lets a real husk be reaped there.
    it('keeps the husk in the adjudicated set, so wp-cleanup still sees it', async () => {
        expect(ADJUDICATED_CLASSIFICATIONS).toContain(CLASSIFICATION_NO_COMMITS);
    });

    it('spares an unmerged branch that has real commits on it', async () => {
        world.localBranches = ['main', 'dean/real-work'];
        world.commitsAhead = { 'dean/real-work': 3 };

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/real-work']);
    });
});

describe('MergedBranchesService safety rails', () => {
    // git refuses to delete the checked-out branch, so never propose it. It is spared LOUDLY (into
    // `keep`, with the reason) rather than dropped, so a human can see what was skipped and why.
    it('never proposes the branch you are standing on', async () => {
        world.mergedPrs = [{ number: 386, headRefName: 'dean/current' }];
        world.localBranches = ['main', 'dean/current'];
        world.currentBranch = 'dean/current';

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/current']);
        expect(cache.keep[0].reason).toContain('checked out in worktree');
    });

    // Offline / gh missing / unauthenticated: we know nothing, so we must propose nothing.
    it('fails soft when gh is unavailable — everything is spared, nothing deletable', async () => {
        world.ghOk = false;
        world.localBranches = ['main', 'dean/a', 'dean/b'];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/a', 'dean/b']);
    });
});

describe('MergedBranchesService worktree verdicts', () => {
    /**
     * The bug this exists to prevent: a merged branch checked out in a LINKED worktree used to land in
     * `deletable` (only the repo-root HEAD was skipped). The emitted reap is ONE `git branch -D a b c`,
     * so git's "Cannot delete branch 'x' checked out at ..." killed the whole command — including the
     * branches that would have deleted fine.
     */
    it('spares a merged branch that a LINKED worktree still holds, and reaps the worktree instead', async () => {
        world.mergedPrs = [{ number: 400, headRefName: 'dean/held' }];
        world.localBranches = ['main', 'dean/held'];
        world.worktrees = [{ path: '/work/held', branch: 'dean/held' }];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/held']);
        expect(cache.keep[0].reason).toContain('/work/held');

        // The worktree carries the verdict: remove it, and the branch becomes reapable.
        expect(cache.worktrees.length).toBe(1);
        expect(cache.worktrees[0].deletable).toBe(true);
        expect(cache.worktrees[0].branch).toBe('dean/held');
    });

    it('spares a locked worktree and one holding unmerged work', async () => {
        world.localBranches = ['main', 'dean/locked', 'dean/live'];
        world.worktrees = [
            { path: '/work/locked', branch: 'dean/locked', extra: 'locked because I said so' },
            { path: '/work/live', branch: 'dean/live' },
        ];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.worktrees.map((t: { deletable: boolean }): boolean => t.deletable)).toEqual([false, false]);
        expect(cache.worktrees[0].reason).toContain('locked');
    });

    it('marks a worktree whose directory is gone as prunable-deletable', async () => {
        world.localBranches = ['main', 'dean/gone'];
        world.worktrees = [{ path: '/work/gone', branch: 'dean/gone', extra: 'prunable gitdir file points to nowhere' }];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.worktrees[0].deletable).toBe(true);
        expect(cache.worktrees[0].reason).toContain('prune');
    });

    it('excludes main from the local branch list', async () => {
        world.localBranches = ['main', 'dean/a'];
        expect(svc.localBranches('/repo')).toEqual(['dean/a']);
    });
});

// The worktree verdicts' CLASSIFICATION half, kept in its own block: `deletable` answers "may the
// tooling reap this unattended?", the token answers "how dead is it, and how is it reaped?" — and
// wp-cleanup needs the second one to prompt, and WorktreeReaper needs it to choose prune vs remove.
describe('MergedBranchesService worktree classifications', () => {
    /**
     * The verdict data has to CLASSIFY a worktree, not merely flag it deletable — otherwise wp-cleanup
     * can auto-reap the provable ones but has nothing to prompt about, and every spared worktree
     * collapses into one undifferentiated "a human must decide" (the exact regression #509 fixed for
     * branches). The token is the branch's own, because the branch is what is being judged.
     */
    it('carries the branch classification through to the worktree verdict', async () => {
        world.mergedPrs = [{ number: 400, headRefName: 'dean/held' }];
        world.allPrs = [{ number: 12, headRefName: 'dean/abandoned', state: 'CLOSED' }];
        world.localBranches = ['main', 'dean/held', 'dean/abandoned'];
        world.commitsAhead = { 'dean/abandoned': 2 };
        world.worktrees = [
            { path: '/work/held', branch: 'dean/held' },
            { path: '/work/abandoned', branch: 'dean/abandoned' },
        ];

        const cache = await svc.computeMergedBranches('/repo', false);
        const byPath = new Map(cache.worktrees.map(
            (tree: { path: string; classification: string }): [string, string] => [tree.path, tree.classification]));

        expect(byPath.get('/work/held')).toBe(CLASSIFICATION_MERGED_PR);
        // Closed unmerged, with later PRs merged: promptable, not auto-reapable.
        expect(byPath.get('/work/abandoned')).toBe(CLASSIFICATION_SUPERSEDED);
    });

    // The three worktree-only outcomes have no branch analogue, and each needs its own token: PRUNABLE
    // is reaped with `git worktree prune` (remove FAILS on it), LOCKED and CURRENT are never promptable.
    it('gives the worktree-only outcomes their own classifications', async () => {
        world.localBranches = ['main', 'dean/gone', 'dean/locked'];
        world.currentBranch = 'dean/here';
        world.worktrees = [
            { path: '/work/gone', branch: 'dean/gone', extra: 'prunable gitdir file points to nowhere' },
            { path: '/work/locked', branch: 'dean/locked', extra: 'locked because I said so' },
        ];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.worktrees[0].classification).toBe(CLASSIFICATION_PRUNABLE);
        expect(cache.worktrees[1].classification).toBe(CLASSIFICATION_LOCKED);
    });

    // The tree the refresher itself is running in is spared with its own token — nothing may ever offer
    // to remove the directory the process is standing in.
    it('classifies the worktree at repoRoot as the current one', async () => {
        world.localBranches = ['main'];
        world.worktrees = [{ path: '/repo', branch: 'main' }];

        const cache = await svc.computeMergedBranches('/repo', false);
        const here = cache.worktrees.find(
            (tree: { path: string }): boolean => tree.path === '/repo');

        expect(here?.classification).toBe(CLASSIFICATION_CURRENT);
        expect(here?.deletable).toBe(false);
    });

});

/**
 * PART 5 — the spared branches used to ALL report the identical string
 * `no merged PR found — a human must decide`. In one observed repo that one string covered a PR closed
 * unmerged and superseded by a later one, a branch that never had a PR and held the only copy of three
 * commits, and content that was already in main. Reporting them identically — then sparing rather than
 * asking — is what let the pile grow to 6 branches against a cap of 5 and wedge a session.
 *
 * Each must now produce a DISTINCT classification, and carry its unique-commit count.
 */
describe('spared-branch classification (Part 5)', () => {
    async function spared(branch: string): Promise<DeletableBranch> {
        const found = (await svc.computeMergedBranches('/repo', false)).keep
            .find((entry: DeletableBranch): boolean => entry.branch === branch);
        if (found === undefined) throw new Error(`${branch} was not spared`);
        return found;
    }

    it('SUPERSEDED — PR closed unmerged, later PRs have merged since', async () => {
        world.localBranches = ['main', 'feature/ONE-2209-checklist-gate'];
        world.allPrs = [{ number: 752, headRefName: 'feature/ONE-2209-checklist-gate', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 754, headRefName: 'feature/ONE-2209-checklist-final' }];
        world.commitsAhead = { 'feature/ONE-2209-checklist-gate': 4 };

        const entry = await spared('feature/ONE-2209-checklist-gate');

        expect(entry.classification).toBe(CLASSIFICATION_SUPERSEDED);
        expect(entry.commits).toBe(4);
        expect(entry.pr).toBe(752);
        expect(entry.reason).toContain('CLOSED UNMERGED');
        expect(entry.reason).toContain('#754');
    });

    it('NEVER-PROPOSED — no PR ever, and the unique-commit count is reported', async () => {
        world.localBranches = ['main', 'dean/webpieces-0-3-322'];
        world.commitsAhead = { 'dean/webpieces-0-3-322': 3 };
        world.cherry = { 'dean/webpieces-0-3-322': '+ aaa\n+ bbb\n+ ccc\n' };

        const entry = await spared('dean/webpieces-0-3-322');

        expect(entry.classification).toBe(CLASSIFICATION_NEVER_PROPOSED);
        expect(entry.commits).toBe(3);
        expect(entry.reason).toContain('never had a PR');
        expect(entry.reason).toContain('3 unique commit(s)');
    });

    it('CONTENT-ALREADY-IN-MAIN — every commit has a patch-equivalent upstream', async () => {
        world.localBranches = ['main', 'dean/cherry-picked'];
        world.commitsAhead = { 'dean/cherry-picked': 2 };
        world.cherry = { 'dean/cherry-picked': '- aaa\n- bbb\n' };

        const entry = await spared('dean/cherry-picked');

        expect(entry.classification).toBe(CLASSIFICATION_CONTENT_IN_MAIN);
        expect(entry.commits).toBe(2);
        expect(entry.reason).toContain('already have an equivalent in origin/main');
    });

});

describe('classification keeps the situations distinct, and still deletes nothing', () => {
    async function spared(branch: string): Promise<DeletableBranch> {
        const found = (await svc.computeMergedBranches('/repo', false)).keep
            .find((entry: DeletableBranch): boolean => entry.branch === branch);
        if (found === undefined) throw new Error(`${branch} was not spared`);
        return found;
    }

    // The three genuinely different situations must not collapse back into one string.
    it('gives the three situations three DIFFERENT classifications and reasons', async () => {
        world.localBranches = ['main', 'a/superseded', 'b/never', 'c/in-main'];
        world.allPrs = [{ number: 10, headRefName: 'a/superseded', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 20, headRefName: 'z/other' }];
        world.commitsAhead = { 'a/superseded': 1, 'b/never': 3, 'c/in-main': 2 };
        world.cherry = { 'b/never': '+ aaa\n', 'c/in-main': '- aaa\n- bbb\n' };

        const classes = (await svc.computeMergedBranches('/repo', false)).keep
            .map((entry: DeletableBranch): string => entry.classification);
        const reasons = new Set((await svc.computeMergedBranches('/repo', false)).keep
            .map((entry: DeletableBranch): string => entry.reason));

        expect(new Set(classes).size).toBe(3);
        expect(reasons.size).toBe(3);
    });

    // The safety posture is UNCHANGED: classifying is not deleting. All three stay in `keep`.
    it('classifies but never auto-deletes — all three remain spared', async () => {
        world.localBranches = ['main', 'a/superseded', 'b/never', 'c/in-main'];
        world.allPrs = [{ number: 10, headRefName: 'a/superseded', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 20, headRefName: 'z/other' }];
        world.commitsAhead = { 'a/superseded': 1, 'b/never': 3, 'c/in-main': 2 };
        world.cherry = { 'c/in-main': '- aaa\n- bbb\n' };

        expect((await svc.computeMergedBranches('/repo', false)).deletable).toEqual([]);
    });

    // A closed PR with NOTHING merged after it is not evidence of supersession — it may simply be work
    // someone abandoned and will come back to.
    it('does not call a branch superseded when no later PR has merged', async () => {
        world.localBranches = ['main', 'dean/abandoned'];
        world.allPrs = [{ number: 99, headRefName: 'dean/abandoned', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 50, headRefName: 'z/older' }];
        world.commitsAhead = { 'dean/abandoned': 2 };

        expect((await spared('dean/abandoned')).classification).toBe(CLASSIFICATION_NEVER_PROPOSED);
    });

    // Proven-dead branches keep their own classifications, so a report can group everything — and a
    // MERGED PR is the ONLY thing that gets a branch into the deletable list. The husk is spared.
    it('classifies the deletable branches too, and a merged PR is the only way in', async () => {
        world.mergedPrs = [{ number: 1, headRefName: 'dean/merged' }];
        world.localBranches = ['main', 'dean/merged', 'dean/mergedPreMerge1', 'dean/husk'];
        world.commitsAhead = { 'dean/husk': 0 };

        const cache = await svc.computeMergedBranches('/repo', false);
        const byBranch = new Map(cache.deletable
            .map((entry: DeletableBranch): [string, string] => [entry.branch, entry.classification]));

        expect(byBranch.get('dean/merged')).toBe(CLASSIFICATION_MERGED_PR);
        expect(byBranch.get('dean/mergedPreMerge1')).toBe(CLASSIFICATION_BACKUP_OF_MERGED);
        expect(byBranch.has('dean/husk')).toBe(false);
        expect(names(cache.keep)).toContain('dean/husk');
    });
});

/**
 * A pre-merge snapshot of a branch that has NOT merged yet.
 *
 * These accumulate fast — every `wp-start-upsert-pr` and `wp-review-upsert-pr` on a branch with an
 * OPEN PR leaves another one, and they are only archived-and-reaped once that PR merges. Until then
 * they were reported as "never had a PR; holds N unique commit(s) that may be the only copy in
 * existence", which is false BY CONSTRUCTION: a snapshot is a copy of its base, and the base is
 * sitting right there in the same listing. That unanswerable question is why nobody ever said yes and
 * the pile grew past maxLocalBranches.
 */
describe('a snapshot whose base is still alive is not the only copy', () => {
    it('classifies a PreMerge snapshot of an OPEN-PR branch as backup-of-live, naming the base', async () => {
        world.allPrs = [{ number: 42, headRefName: 'dean/feature', state: 'OPEN' }];
        world.localBranches = ['main', 'dean/feature', 'dean/featurePreMerge1', 'dean/featurePreMerge2'];

        const cache = await svc.computeMergedBranches('/repo', false);
        const byBranch = new Map(cache.deletable
            .map((entry: DeletableBranch): [string, DeletableBranch] => [entry.branch, entry]));

        for (const snapshot of ['dean/featurePreMerge1', 'dean/featurePreMerge2']) {
            const entry = byBranch.get(snapshot)!;
            expect(entry.classification).toBe(CLASSIFICATION_BACKUP_OF_LIVE);
            expect(entry.reason).toContain("snapshot of 'dean/feature'");
            expect(entry.reason).toContain('PR #42 OPEN');
            // The exact claim that made this unanswerable must be gone.
            expect(entry.reason).not.toContain('only copy in existence');
        }
    });

    it('still classifies it as a live snapshot when the base has no PR at all', async () => {
        world.localBranches = ['main', 'dean/feature', 'dean/featureSquash'];

        const entry = (await svc.computeMergedBranches('/repo', false)).deletable
            .find((row: DeletableBranch): boolean => row.branch === 'dean/featureSquash')!;

        expect(entry.classification).toBe(CLASSIFICATION_BACKUP_OF_LIVE);
        expect(entry.reason).toContain('no PR yet');
        expect(entry.reason).not.toContain('only copy in existence');
    });

    /**
     * The one case where the scary wording is CORRECT. With the base gone, a snapshot really may hold
     * the last copy of that work, so it must fall back to never-proposed rather than being waved
     * through as a spare.
     */
    it('falls back to never-proposed when the base branch no longer exists', async () => {
        world.localBranches = ['main', 'dean/orphanPreMerge1'];

        const entry = (await svc.computeMergedBranches('/repo', false)).keep
            .find((row: DeletableBranch): boolean => row.branch === 'dean/orphanPreMerge1')!;

        expect(entry.classification).toBe(CLASSIFICATION_NEVER_PROPOSED);
        expect(entry.reason).toContain('only copy in existence');
    });

    // A merged base still wins: that verdict is DELETABLE, and this change must not downgrade it to
    // a spared prompt, or snapshots would stop being auto-reaped after their PR lands.
    it('does not shadow backup-of-merged when the base branch still exists locally', async () => {
        world.mergedPrs = [{ number: 7, headRefName: 'dean/landed' }];
        world.localBranches = ['main', 'dean/landed', 'dean/landedPreMerge1'];

        const entry = (await svc.computeMergedBranches('/repo', false)).deletable
            .find((row: DeletableBranch): boolean => row.branch === 'dean/landedPreMerge1')!;

        expect(entry.classification).toBe(CLASSIFICATION_BACKUP_OF_MERGED);
    });

    /**
     * NOT promptable — auto-reaped. It was once the FIRST promptable group, described in its own doc
     * as "the easiest yes in the list", which is the tell: a question whose only honest answer is yes
     * is toil, not consent. `wp-start-upsert-pr` mints one of these per run, so they were the bulk of
     * every "which of these 6 branches may I delete?" the tooling put to a human.
     */
    it('is auto-reaped rather than put to a human', async () => {
        expect(ADJUDICATED_CLASSIFICATIONS).not.toContain(CLASSIFICATION_BACKUP_OF_LIVE);
    });
});

/**
 * The incident this whole change exists for: `branch-creation-guard` offered to delete three worktrees
 * that had live agents working in them, on the strength of "a branch with no commits of its own".
 * These lock the verdicts at the level the guard actually reads.
 */
describe('worktree liveness is "live unless merged"', () => {
    it('treats a worktree whose branch has no commits and no PR as LIVE, never deletable', async () => {
        world.localBranches = ['main', 'dean/apipath'];
        world.commitsAhead = { 'dean/apipath': 0 };
        world.worktrees = [{ path: '/wt/apipath', branch: 'dean/apipath' }];

        const verdict = (await svc.computeMergedBranches('/repo', false)).worktrees
            .find((tree: DeletableWorktree): boolean => tree.path === '/wt/apipath');

        expect(verdict?.deletable).toBe(false);
        expect(verdict?.classification).toBe(CLASSIFICATION_NO_COMMITS);
    });

    // The mirror image: a MERGED PR is proof, and proof still reaps without asking.
    it('marks a worktree whose PR is merged as deletable', async () => {
        world.mergedPrs = [{ number: 514, headRefName: 'dean/landed' }];
        world.localBranches = ['main', 'dean/landed'];
        world.worktrees = [{ path: '/wt/landed', branch: 'dean/landed' }];

        const verdict = (await svc.computeMergedBranches('/repo', false)).worktrees
            .find((tree: DeletableWorktree): boolean => tree.path === '/wt/landed');

        expect(verdict?.deletable).toBe(true);
        expect(verdict?.classification).toBe(CLASSIFICATION_MERGED_PR);
        expect(verdict?.pr).toBe(514);
    });

    // An OPEN PR with real commits was already spared correctly and must stay that way.
    it('spares a worktree whose PR is open', async () => {
        world.allPrs = [{ number: 514, headRefName: 'dean/in-review', state: 'OPEN' }];
        world.localBranches = ['main', 'dean/in-review'];
        world.commitsAhead = { 'dean/in-review': 1 };
        world.worktrees = [{ path: '/wt/review', branch: 'dean/in-review' }];

        const verdict = (await svc.computeMergedBranches('/repo', false)).worktrees
            .find((tree: DeletableWorktree): boolean => tree.path === '/wt/review');

        expect(verdict?.deletable).toBe(false);
        expect(verdict?.reason).toContain('not merged');
    });

    /**
     * Ticket part 2: the refresher must record a status for EVERY worktree and EVERY branch, so no
     * consumer ever has an excuse to re-derive one. `main` is the single deliberate omission on each
     * side (the primary clone cannot be removed; the main branch is never reaped).
     */
    it('records a verdict for every linked worktree and every non-main branch', async () => {
        world.mergedPrs = [{ number: 1, headRefName: 'dean/merged' }];
        world.localBranches = ['main', 'dean/merged', 'dean/husk', 'dean/held', 'dean/parked'];
        world.commitsAhead = { 'dean/husk': 0 };
        world.worktrees = [
            { path: '/wt/merged', branch: 'dean/merged' },
            { path: '/wt/husk', branch: 'dean/husk' },
            { path: '/wt/held', branch: 'dean/held' },
            { path: '/wt/gone', branch: 'dean/parked', extra: 'prunable' },
        ];

        const cache = await svc.computeMergedBranches('/repo', false);

        expect(cache.worktrees.map((tree: DeletableWorktree): string => tree.path).sort())
            .toEqual(['/wt/gone', '/wt/held', '/wt/husk', '/wt/merged']);
        expect([...names(cache.deletable), ...names(cache.keep)].sort())
            .toEqual(['dean/held', 'dean/husk', 'dean/merged', 'dean/parked']);
    });
});

/**
 * Ticket part 4: the guard asserted "8 parked local branches" over a repo that had ONE, because it
 * quoted a cache written before those branches were deleted, and then BLOCKED on that figure.
 */
describe('cache freshness and reconciliation', () => {
    const NOW = Date.parse('2026-07-30T12:00:00.000Z');

    function cache(timestamp: string): MergedBranchesCache {
        return new MergedBranchesCache(
            timestamp,
            [new DeletableBranch('dean/gone', 'PR #1 merged', 1)],
            [new DeletableBranch('dean/here', 'no merged PR', 0)],
            [new DeletableWorktree('/wt/gone', 'dean/gone', 'PR #1 merged', 1, true),
             new DeletableWorktree('/wt/here', 'dean/here', 'no merged PR', 0, false)],
        );
    }

    it('calls a cache written minutes ago fresh, and an hour-old one stale', async () => {
        expect(svc.freshness(cache('2026-07-30T11:59:00.000Z'), NOW).stale).toBe(false);
        const old = svc.freshness(cache('2026-07-30T11:00:00.000Z'), NOW);
        expect(old.stale).toBe(true);
        expect(old.ageMinutes).toBe(60);
    });

    // A cache with no usable timestamp cannot be dated, so it can never be quoted as fact.
    it('treats a missing or unparseable timestamp as stale', async () => {
        expect(svc.freshness(cache(''), NOW).stale).toBe(true);
        expect(svc.freshness(cache(''), NOW).ageMinutes).toBe(-1);
    });

    it('drops cached entries whose branch or worktree no longer exists', async () => {
        world.localBranches = ['main', 'dean/here'];
        world.worktrees = [{ path: '/wt/here', branch: 'dean/here' }];

        const reconciled = svc.reconcile('/repo', cache('2026-07-30T11:00:00.000Z'));

        expect(reconciled.deletable).toEqual([]);
        expect(names(reconciled.keep)).toEqual(['dean/here']);
        expect(reconciled.worktrees.map((tree: DeletableWorktree): string => tree.path)).toEqual(['/wt/here']);
    });

    // "git could not answer" must never read as "everything was deleted".
    it('leaves the cache alone when git reports nothing at all', async () => {
        world.localBranches = [];
        const reconciled = svc.reconcile('/repo', cache('2026-07-30T11:00:00.000Z'));
        expect(reconciled.deletable.length).toBe(1);
        expect(reconciled.keep.length).toBe(1);
    });
});
