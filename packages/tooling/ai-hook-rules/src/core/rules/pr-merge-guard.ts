import { execSync } from 'child_process';

import { PrLifecycleGuardConfig, PR_LIFECYCLE_GUARD_KEY } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { TreeRecovery, TreeKind } from './tree-recovery';

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class PrMergeGuardRule extends BashRuleBase<PrLifecycleGuardConfig> {
    constructor(config: PrLifecycleGuardConfig) { super(config, 'pr-merge-guard', PR_LIFECYCLE_GUARD_KEY); }

    readonly description = 'Redirect a hand-rolled `gh pr merge` to `pnpm wp-land-pr`, then require branch cleanup.';

    // Substituted with the real branch name in check(); the getter reads it. Placeholder until then.
    private currentBranch = '<current-branch>';

    // The tree we are standing in, resolved in check() so fixHint renders the ONE cleanup that
    // actually works here. 'unknown' until check() runs (fixHint is also read before/without it).
    private treeKind: TreeKind = 'unknown';
    private worktreePath = '<worktree-dir>';

    private readonly recovery = new TreeRecovery();

    // Single fix, no distinct options — the whole guidance lives in mainMessage so it renders as
    // one coherent block (never split into fake "Fix Option 1/2/3").
    //
    // `pnpm wp-cleanup` rather than `git branch -d <branch>`: a raw `-d` reads as destructive, so
    // agents ask permission and stop, and the branch survives. wp-cleanup is one named command that
    // deletes ONLY provably-dead branches — and it reaps every OTHER dead branch at the same time,
    // which is the moment that actually keeps the local branch list bounded.
    get fixHint(): FixHint {
        return new FixHint(
            'Land the PR with `pnpm wp-land-pr`, never a hand-rolled `gh pr merge`.',
            [
                'A bare `gh pr merge` leaves the commit message to the repo\'s squash_merge_commit_title/',
                'message settings. On a repo set to PR_TITLE + PR_BODY that now happens to be RIGHT — the',
                'PR description IS the gated commit body — but on any other combination it is wrong, and',
                'commonly means the internal "Squash merge of <branch>" subject. `pnpm wp-land-pr` passes',
                '`--subject`/`--body-file` explicitly, so it is right on EVERY repo regardless of settings:',
                '',
                '  pnpm wp-land-pr',
                '',
                'It squash-merges when the PR is mergeable, and enables auto-merge with the same',
                'subject/body when the checks are still running. It also does the two things a raw merge',
                'never does: archive the pre-squash tip as archive/<date>/<branch>, and reap the landed',
                'worktree. Then clean up:',
                '',
            ]
                .concat(this.recovery.cleanupSteps(this.treeKind, this.currentBranch, this.worktreePath))
                .concat(['', "Add this to your memory so you don't forget next time and waste tokens."])
                .join('\n'),
        );
    }

    /**
     * Any hand-rolled `gh pr merge` is blocked outright — there is no "but I cleaned up afterwards"
     * escape, because the damage is the commit message that merge writes into main, which cleanup
     * cannot undo. `pnpm wp-land-pr` is the way through; its own `gh pr merge` runs as a child
     * process this hook never sees, exactly like the other gated commands.
     *
     * ─── Why a CORRECT-LOOKING `gh pr merge --auto --subject --body-file` is still blocked ──────────
     * Full reasoning, and what was rejected: `decisions/0005-the-pr-description-is-the-merge-body.md`
     * § "pr-merge-guard stays blocking" (which supersedes `0004` § 8). It has now been re-examined
     * twice — once when the gated body moved out of the worktree, and again when it moved onto the PR
     * itself — and the block stands. A `--body-file` proves a file was passed, never that it holds the
     * GATED bytes: the guard sees a command string and cannot read the file, so any file at all — a
     * hand-written one, an older run's — could land as the reviewed body with nothing to distinguish it
     * afterwards.
     *
     * One more thing depends on that: landing DECIDES whether the archive/merge-info/reap bookkeeping
     * belongs to this tree, by comparing this tree's branch tip against the PR's `headRefOid`. A
     * hand-rolled merge skips that decision silently, which is how a landed worktree becomes a corpse.
     *
     * The tree kind still decides which cleanup steps the hint prints: in a linked worktree
     * `git checkout main` FATALS, so demanding it there would be demanding an impossible command.
     */
    check(ctx: BashContext): readonly Violation[] {
        if (!/gh\s+pr\s+merge/.test(ctx.commandCode)) return [];

        this.treeKind = this.recovery.kindOf(ctx.workspaceRoot);
        this.currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();
        this.worktreePath = ctx.workspaceRoot;

        return [new V(1, truncate(ctx.command))];
    }
}
