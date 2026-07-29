/**
 * The "you are on a stale main" text, shared by the TWO guards that detect the state from the same
 * cached signal (`MainSyncStatus.localMain` vs `originMain`):
 *
 *   - read-stale-guard        blocks the Read tool     → {@link StaleMainMessage.forReads}
 *   - stale-main-bash-guard   blocks content-read Bash → {@link StaleMainMessage.forBash}
 *
 * One source of truth on purpose (same reason as MergedBranchMessage): the cure is an instruction the
 * AI follows literally, so two drifting copies mean two behaviors for one repo state. Only the
 * "what is still allowed" tail differs, because the two guards block different tools.
 *
 * The cure is `--ff-only` deliberately. A plain `git pull` on a stale main can start a MERGE, which
 * is the one thing redirect-how-to-merge-main exists to keep an AI away from; `--ff-only` either
 * fast-forwards (the case here, since the block only fires when the tree is clean and behind) or
 * fails loudly without touching anything.
 */
export class StaleMainMessage {
    // The diagnosis + cure. Identical for both guards — the part that must never drift.
    private common(behindCount: string): string[] {
        return [
            `You are on main and main is ${behindCount} commit(s) behind origin/main.`,
            'Anything you read here is STALE, and every plan built from it is built on code that no',
            'longer exists upstream.',
            '',
            'Run exactly this, then retry:',
            '  git pull --ff-only origin main',
            '',
            'If that fatals with "Cannot fast-forward to multiple branches", .git/FETCH_HEAD holds a',
            'duplicate entry — clear it with `git fetch --prune origin main`, then pull again.',
        ];
    }

    forReads(behindCount: string): string {
        return this.common(behindCount).concat([
            '',
            'Still allowed while this block is up:',
            '  - Bash that does not read repo files: builds, tests, installs, the pull itself, and all',
            '    git/gh METADATA (status|log|diff|show|branch)',
            '  - All Write/Edit (feature-branch-guard governs those separately)',
            '  - Reading and editing webpieces.config.json (set read-stale-guard mode OFF to disable)',
        ]).join('\n');
    }

    /**
     * The Bash variant. stale-main-bash-guard blocks only CONTENT reads, so the message has to say
     * which shell is still open — an agent that reads "Bash blocked" and believes the whole shell is
     * gone will not run the cure, which is itself a Bash command.
     */
    forBash(behindCount: string): string {
        return this.common(behindCount).concat([
            '',
            'This command was blocked because it reads FILE CONTENT out of the stale tree (cat/grep/',
            'ls/find/sed/awk/git grep/git show <rev>:<path>). That is how stale bytes get into your',
            'context and quietly poison everything you conclude — the incident behind this guard had',
            'an agent describing a CI workflow set that was missing a whole workflow added upstream.',
            '',
            'Still allowed right now (the cure is one of these):',
            '  - git pull/fetch, installs, upgrades, builds, tests, every other non-reading command',
            '  - git/gh METADATA: status, log, diff, show <rev>, branch, rev-list, gh pr list|view',
            '  - reads against the CURRENT upstream tree: git show origin/main:<path>, git grep <pat> origin/main',
            '  - all Write/Edit, and reading webpieces.config.json (set stale-main-bash-guard mode OFF to disable)',
        ]).join('\n');
    }
}
