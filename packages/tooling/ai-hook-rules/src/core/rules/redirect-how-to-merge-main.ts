import { execSync } from 'child_process';

import { RedirectHowToMergeMainConfig, RepoRootFinder } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { CommandScanner } from '../command-scan';
import { TreeRecovery } from './tree-recovery';

const INSTRUCT_FILE = 'webpieces.git-workflow.md';
const UPDATE_COMMAND = 'pnpm wp-start-update';

const FIX_HINT = new FixHint(
    '`git merge` / `git rebase` are never run by AI — on any branch, in any form.',
    'To bring main\'s changes into your feature branch:\n'
    + `  ${UPDATE_COMMAND}        (then: pnpm wp-finish-upsert-pr)\n`
    + 'That does a 3-point merge (fork-point=A, feature-HEAD=B, main-HEAD=C), which is what keeps PR\n'
    + 'diffs clean. A raw `git merge`/`git rebase` destroys the fork-point system. The gated commands\n'
    + 'merge internally as child processes this hook never sees, so they are unaffected by this guard.\n'
    + '\n'
    + 'If you believe a raw merge/rebase is genuinely required, do NOT run it and do NOT work around\n'
    + 'this guard. STOP and ask the HUMAN to run that exact command themselves — and when you ask,\n'
    + 'warn them, in these words:\n'
    + '\n'
    + '  "I am asking you to run a raw git merge/rebase. This is almost always the WRONG call —\n'
    + `   \`${UPDATE_COMMAND}\` / \`pnpm wp-finish-upsert-pr\` does a 3-point merge and is the correct\n`
    + '   flow. Please push back and tell me to use the 3-point merge instead, unless you are certain\n'
    + '   this is a genuine exception."\n'
    + '\n'
    + 'READ the instruct-ai git-workflow doc at the absolute path on the violation line above for the\n'
    + 'full flow (incl. worktrees).\n'
    + 'Add that info to memory so you remember next time.',
);

// `git merge --abort` / `git rebase --abort|--quit` UNDO an in-progress operation — they cannot create
// a merge commit or rewrite history, so they cannot violate the fork-point invariant this rule
// protects. They stay allowed so a repo left mid-operation (e.g. by a human-run rebase) can still be
// cleaned up. `--continue` is deliberately NOT here: it COMPLETES the operation.
const UNDO_FLAG = /--(?:abort|quit)\b/;

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

// Switches to a branch OTHER than main. `git branch -D <x>` is not a checkout so it does not trip
// this; `checkout main` and flag-only forms like `checkout -` do not count as a feature switch.
const SWITCHES_TO_NON_MAIN = /git\s+(?:checkout|switch)\s+(?!main\b|-\s|-$)\S+/;

export class RedirectHowToMergeMainRule extends BashRuleBase<RedirectHowToMergeMainConfig> {
    private readonly scanner = new CommandScanner();
    private readonly recovery = new TreeRecovery();

    constructor(config: RedirectHowToMergeMainConfig) { super(config, 'redirect-how-to-merge-main'); }

    readonly description = 'Block ALL `git merge`/`git rebase` (any branch, any form) and `git pull origin main` on a feature branch. Use the squash-update process instead.';
    readonly fixHint = FIX_HINT;

    check(ctx: BashContext): readonly Violation[] {
        for (const segment of this.scanner.commandSegments(ctx.command)) {
            const violation = this.checkSegment(ctx, segment);
            if (violation !== null) return [violation];
        }
        return [];
    }

    private checkSegment(ctx: BashContext, segment: string): Violation | null {
        // 1. merge/rebase: unconditional block. Deliberately NO branch lookup.
        //
        // This rule used to read hook-time HEAD and bail out when it was `main`. But a PreToolUse hook
        // runs BEFORE the command, so HEAD-at-hook-time is a value the command itself is about to
        // change: `git checkout feat && git rebase main`, issued while HEAD was still `main` from a
        // prior cleanup, read as "we're on main, this is fine" and was waved through. That is the
        // incident this rule exists to prevent. Since merge/rebase have no legitimate AI-run form on
        // ANY branch, there is no branch to consult — and so no HEAD to spoof.
        if (this.scanner.invokesGit(segment, 'merge') || this.scanner.invokesGit(segment, 'rebase')) {
            if (UNDO_FLAG.test(segment)) return null;
            return this.block(ctx, segment, 'Direct `git merge`/`git rebase` is blocked — AI never runs it, on any branch.');
        }

        // 2. pull: unlike merge/rebase this DOES retain a legitimate on-main form
        // (`git checkout main && git pull origin main`), so it must consult the branch — which is
        // exactly why it also needs the branch-switch check that (1) no longer requires.
        if (this.scanner.invokesGit(segment, 'pull') && /\borigin\s+main\b/.test(segment)) {
            return this.checkPull(ctx, segment);
        }

        return null;
    }

    private checkPull(ctx: BashContext, segment: string): Violation | null {
        if (SWITCHES_TO_NON_MAIN.test(ctx.command)) {
            return this.block(ctx, segment, 'Blocked: this command switches to a feature branch and then pulls main into it.');
        }
        // The recommended `git checkout main && git pull origin main` — but ONLY in the primary
        // clone. Inside a linked worktree that checkout FATALS ("'main' is already checked out at
        // <primary>"), so waving it through here hands the AI a command that cannot work and costs
        // it a turn to discover. Steer to the fetch, which is all a worktree needs.
        if (/git\s+(?:checkout|switch)\s+main\b/.test(ctx.command)) {
            if (this.recovery.kindOf(ctx.workspaceRoot) !== 'worktree') return null;
            // updateMainSteps already explains the worktree/fatal reasoning — don't say it twice.
            return this.block(ctx, segment, ['Blocked.', ...this.recovery.updateMainSteps('worktree')].join('\n'));
        }

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();
        if (currentBranch === 'main') return null;

        return this.block(ctx, segment, `Pulling main into feature branch '${currentBranch}' is blocked.`);
    }

    private block(ctx: BashContext, segment: string, what: string): Violation {
        const docPath = new RepoRootFinder().instructAiDocPath(ctx.workspaceRoot, INSTRUCT_FILE);
        return new V(
            1,
            truncate(segment),
            `${what} Use '${UPDATE_COMMAND}' (3-point merge). If you truly need a raw merge/rebase, ask the HUMAN to run it — and warn them to push back. Full flow: READ ${docPath}.`,
        );
    }
}
