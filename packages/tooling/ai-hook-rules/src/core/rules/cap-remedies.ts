import { FixHint } from '../fix-hint';
import { Option } from '@webpieces/rules-config';

/**
 * What branch-creation-guard says when a CAP is what blocked. TWO SHORT LINES, and never a
 * destructive command.
 *
 * It used to be forty. The branch remedy printed every spared branch with its SHA, PR state, unique
 * commit count and prose reason, told the agent to paste that table at the human and ask which may
 * go, and then listed the config knobs it must not touch. The human's verdict on that, verbatim:
 * "I am tired of AI asking me to cleanup things it can do by itself". They were right twice over —
 * the wall of text buried the one actionable line, and the biggest spared group (pre-merge snapshots
 * of a branch that still exists) was never a judgement call at all. That group is auto-reaped now
 * (see CLASSIFICATION_BACKUP_OF_LIVE), so the remedy is one command.
 *
 * Everything this class used to say still exists — in `pnpm wp-cleanup`, which recomputes the
 * verdicts fresh, archives each branch as an `archive/<date>/<branch>` tag before deleting, logs a
 * `recover=` command per removal, refuses the primary clone and the tree it is standing in, never
 * passes `--force`, and PROMPTS about anything not provably dead. A guard that duplicates that
 * inventory is a second copy to keep in sync and a wall to read before running the command anyway.
 * So: name the command, stop talking.
 */
export class CapRemedies {
    /**
     * Deliberately takes no cache and quotes no figures. The cache is allowed to be stale by design,
     * and a stale table is worse than no table when the reader's next move is `wp-cleanup` — which
     * recomputes from scratch — either way.
     *
     * "ASK THE HUMAN" stays spelled out. Shortening it to a bare "ask" saves two words and loses the
     * object of the verb — and the reader is an agent, which can satisfy a bare "ask" by asking
     * itself. Every other guard in this codebase says ASK THE HUMAN for the same reason.
     */
    branchCap(): FixHint {
        return new FixHint(
            'Too many local branches.',
            '',
            [
                new Option('Run: pnpm wp-cleanup — reaps the dead branches, prompts about the rest.', true),
                new Option(
                    'Only if that leaves you at the cap: ASK THE HUMAN which of the branches it spared ' +
                    'may go. Never delete a spared branch or edit webpieces.config.json ' +
                    '(maxLocalBranches / turnOffRuleUntilEpoch) without their explicit yes.',
                ),
            ],
        );
    }

    /**
     * Same shape for worktrees, with one extra sentence that is not boilerplate: a worktree whose
     * branch has no commits yet is almost always one an agent is working in RIGHT NOW. That is why
     * this never emits `git worktree remove` — it once printed a `prune && remove && branch -D` chain
     * naming three live worktrees under the words "so no work can be lost".
     */
    worktreeCap(): FixHint {
        return new FixHint(
            'Too many worktrees. Do NOT remove one by hand — an agent may be working in it right now.',
            '',
            [
                new Option('Run: pnpm wp-cleanup — removes the dead worktrees, prompts about the rest.', true),
                new Option(
                    'Only if that leaves you at the cap: ASK THE HUMAN which of the worktrees it spared ' +
                    'may go. Never edit webpieces.config.json (maxWorktrees / turnOffRuleUntilEpoch) ' +
                    'without their explicit yes.',
                ),
            ],
        );
    }
}
