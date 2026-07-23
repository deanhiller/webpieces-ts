// SINGLE SOURCE OF TRUTH for "how do I bring main into my branch" as told to an AI.
//
// Why this file exists: the guards and the pr-gate bins each used to hand-write their own version of
// this advice, and they drifted — one message told the AI to START with `wp-start-update` and FINISH
// with `wp-finish-upsert-pr`, which is a pairing that does not exist. An AI reading that cannot tell
// which flow it is in. Every guard/bin message now renders from HERE, so the two flows can only ever
// be described one way.

// The four gated bins, as the AI must type them. Two flows, two halves each.
export const WP_START_UPDATE = 'pnpm wp-start-update';
export const WP_FINISH_UPDATE = 'pnpm wp-finish-update';
export const WP_START_UPSERT_PR = 'pnpm wp-start-upsert-pr';
export const WP_FINISH_UPSERT_PR = 'pnpm wp-finish-upsert-pr';

/**
 * Renders the canonical guidance blocks. Methods return string[] (not a joined string) so callers can
 * indent//interleave them into their own message without re-wrapping.
 */
export class SyncFlowGuidance {
    /**
     * Both flows, ALWAYS paired. Use this when the caller does NOT know whether a PR is open — an AI
     * shown only one flow picks it even when the other one is the correct one.
     */
    flows(): string[] {
        return [
            'There are exactly TWO flows. Which one you use is decided by ONE question:',
            'is there already an OPEN PR for this branch?',
            '',
        ]
            .concat(this.updateOnlyFlow())
            .concat([''])
            .concat(this.prFlow())
            .concat([''])
            .concat(this.pairingRule())
            .concat([''])
            .concat(this.whyPrForcesFlowB());
    }

    /** Flow A — no PR open yet. */
    updateOnlyFlow(): string[] {
        return [
            '  A. NO PR yet — update-only flow (you are mid-work and just want main\'s changes):',
            `     1. ${WP_START_UPDATE}      ← 3-point merge from main (auto-finalizes if clean)`,
            '     2. /wp-merge                 ← resolve conflicts (ONLY if step 1 reported any)',
            `     3. ${WP_FINISH_UPDATE}     ← finalize (ONLY on the conflict path)`,
        ];
    }

    /** Flow B — a PR is open (or is about to be). */
    prFlow(): string[] {
        return [
            '  B. A PR IS ALREADY OPEN (or you are ready to post one) — PR flow:',
            `     1. ${WP_START_UPSERT_PR}   ← same 3-point merge, then push`,
            '     2. /wp-merge                 ← resolve conflicts (ONLY if step 1 reported any)',
            `     3. ${WP_FINISH_UPSERT_PR}  ← authoritative build gate, then create/update the PR`,
        ];
    }

    /** The half that keeps drifting: a start from one pair NEVER finishes with the other's finish. */
    pairingRule(): string[] {
        return [
            'PAIRING IS NOT OPTIONAL — a start and a finish from different flows is not a thing:',
            '  wp-start-update    → wp-finish-update',
            '  wp-start-upsert-pr → wp-finish-upsert-pr',
        ];
    }

    /** Why an open PR removes the choice. Safe to print on its own alongside just the PR flow. */
    whyPrForcesFlowB(): string[] {
        return [
            'If a PR is open you MUST use the upsert-pr pair. The 3-point merge REWRITES this branch (it',
            'squashes onto main and force-pushes a new generation), so the open PR\'s history is blown',
            'away and has to be re-pointed in the SAME run. The update-only pair never touches the PR, so',
            'running it with a PR open would strand that PR on the OLD branch generation — which is why',
            'wp-start-update refuses outright when it finds an open PR.',
        ];
    }

    /**
     * The start bin that PAIRS with a finish bin (bare names, no `pnpm` prefix) — so generated text can
     * name the command that actually produced it instead of guessing one of the two. Anything
     * unrecognized comes back unchanged rather than inventing a name.
     */
    pairedStart(finishCommand: string): string {
        if (finishCommand === 'wp-finish-update') return 'wp-start-update';
        if (finishCommand === 'wp-finish-upsert-pr') return 'wp-start-upsert-pr';
        return finishCommand;
    }

    /**
     * "How do I get main itself current?" — a DIFFERENT question from syncing a feature branch, and
     * the one that had no answer in the merge block (which sent readers to reset --hard for lack of
     * one). Single line, and deliberately free of backticks / `$` / double quotes so it can be
     * interpolated straight into the shim's double-quoted shell REASON string.
     */
    updateMainAdvice(): string {
        return 'To get main itself current: ON main, run \'git pull origin main\'. In a linked worktree '
            + '(main is checked out in the primary clone, so checkout main fatals there), run '
            + '\'git fetch origin main\' and branch off origin/main. Do NOT reach for git merge '
            + '--ff-only / git reset --hard / git checkout -B main: merge and rebase are blocked in '
            + 'EVERY form by redirect-how-to-merge-main, and the reset/-B forms silently throw away '
            + 'commits. To sync a FEATURE branch from main use pnpm wp-start-update (no PR open) or '
            + 'pnpm wp-start-upsert-pr (a PR is open).';
    }

    /**
     * The read-only alternatives, for when the AI only wanted to LOOK at how it stands vs main. This
     * exists because `git merge --ff-only origin/main` gets typed as if it were a query — it is not,
     * it mutates the branch whenever it succeeds, which is exactly the case you were probing for.
     */
    readOnlyChecks(): string[] {
        return [
            'Only wanted to LOOK (am I behind main? would it fast-forward?) — none of the below mutate:',
            '  git fetch origin main                                 ← refresh the remote ref (no merge)',
            '  git merge-base --is-ancestor origin/main HEAD         ← exit 0 = already contains main',
            '  git rev-list --left-right --count origin/main...HEAD  ← prints "<behind>  <ahead>"',
            '  git log --oneline HEAD..origin/main                   ← what main has that you do not',
            '  git diff --stat origin/main...HEAD                    ← what you changed since the fork point',
            '  cat .webpieces/main-sync-status.json                  ← the tooling\'s own answer, incl.',
            '                                                          the files predicted to conflict',
            '`git merge --ff-only` is NOT a look — it MUTATES on success (that is the whole point of a',
            'fast-forward), so it is blocked like every other merge. Never use it as a probe.',
        ];
    }
}
