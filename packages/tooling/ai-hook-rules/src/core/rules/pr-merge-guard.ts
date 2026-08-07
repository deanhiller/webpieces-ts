import { execSync } from 'child_process';

import { PrMergeGuardConfig } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { TreeRecovery, TreeKind } from './tree-recovery';

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class PrMergeGuardRule extends BashRuleBase<PrMergeGuardConfig> {
    constructor(config: PrMergeGuardConfig) { super(config, 'pr-merge-guard'); }

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
                'A bare `gh pr merge` writes the WRONG commit message into main. GitHub then falls back to',
                'the repo\'s squash_merge_commit_title/message settings, which commonly means the internal',
                '"Squash merge of <branch>" subject — and NEVER the compact risk/flags body, because no',
                'value of those settings can produce it. Only an explicit `--subject`/`--body-file` can,',
                'and `pnpm wp-land-pr` passes exactly the pair that `wp-finish-upsert-pr` already rendered:',
                '',
                '  pnpm wp-land-pr',
                '',
                'It squash-merges when the PR is mergeable, and enables auto-merge with the same',
                'subject/body when the checks are still running. Then clean up:',
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
     * Full reasoning, and what was rejected: `decisions/0004-pr-artifacts-are-machine-global.md` § 8.
     * It was re-examined when the gated body moved to its machine-global home, and the block stands. A
     * `--body-file` proves a file was passed, never that it holds the GATED bytes: the guard sees a
     * command string, cannot know the PR number, and so cannot check the path against
     * `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/merge-commit-body.md`. Allowing the shape would let any
     * file at all — including a hand-written one, or the PR description — land as the reviewed body,
     * with nothing to distinguish it afterwards.
     *
     * Two things now depend on that. `wp-land-pr --fallback-title-only` is a HUMAN opt-in that stamps
     * "this is a fallback" into the commit; a permitted hand-rolled merge would be the same degraded
     * outcome with no stamp and no opt-in. And landing now DECIDES whether the archive/merge-info/reap
     * bookkeeping belongs to this tree, using the provenance filed beside the body — a hand-rolled merge
     * skips that decision silently, which is how a landed worktree becomes a corpse.
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
