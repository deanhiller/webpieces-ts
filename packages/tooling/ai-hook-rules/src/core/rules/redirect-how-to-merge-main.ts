import { execSync } from 'child_process';

import { RedirectHowToMergeMainConfig, RepoRootFinder, SyncFlowGuidance, writeTemplate } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';
import { CommandScanner } from '../command-scan';
import { TreeRecovery } from './tree-recovery';
import { BranchSwitch, BranchSwitchScan } from './branch-switch-scan';

const INSTRUCT_FILE = 'webpieces.git-workflow.md';
const GUIDANCE = new SyncFlowGuidance();

const FIX_HINT = new FixHint(
    '`git merge` / `git rebase` are never run by AI — on any branch, in any form.',
    'To bring main\'s changes into your feature branch:\n'
    + '\n'
    + GUIDANCE.flows().join('\n') + '\n'
    + '\n'
    // The fork-point DERIVATION (why the invariant has two halves, and the three consumers a polluted
    // fork point corrupts) and the WORD-FOR-WORD warning to hand the human are NOT here on purpose.
    // Both are stated in full in the git-workflow doc this hint links by absolute path, and a message
    // that re-derives what the linked doc already says is a second copy to keep in step. What survives
    // here is only what changes what the AI types next.
    + 'Either flow does a 3-point merge, which keeps the fork point a pure main commit — what the build\n'
    + 'gate\'s --base and the PR review diff are computed from; a raw merge/rebase destroys it. The\n'
    + 'gated commands merge internally as child processes this hook never sees.\n'
    + '\n'
    + GUIDANCE.readOnlyChecks().join('\n') + '\n'
    + '\n'
    // The "do not run it, ask the human, tell them to push back" instruction is NOT repeated here: the
    // violation line the AI reads first already says it. This paragraph's job is only the pointer.
    // The liveness phrase is kept on ONE line deliberately: it is asserted in full, and a wrap would
    // split the assertion's substring across two chunks. The retired wording ("a branch you do not own")
    // was pinned only by a `never sync a branch` PREFIX, which passed under both framings — which is how
    // this hint kept teaching the removed rule after the doc it links had replaced it.
    + 'READ the instruct-ai git-workflow doc at the absolute path on the violation line above — the full\n'
    + 'flow (incl. worktrees), the fork-point invariant, why you must\n'
    + 'never sync a branch something is ACTIVELY holding (liveness, not authorship — a finished agent\n'
    + 'holds nothing), and the exact words to warn a human with when you ask them to run a merge.\n'
    // NOT "add that info to memory": "that info" was the whole git-workflow doc, which is REGENERATED
    // per repo and per version — memorizing it guarantees a stale recall in the next session. Only the
    // invariant is stable enough to persist; the doc must be re-read, never remembered.
    + 'Add to memory: never run a raw `git merge`/`git rebase` — use this repo\'s gated sync flow and\n'
    + 're-read its git-workflow doc each time rather than recalling it (regenerated per repo/version).',
);

// `git merge --abort` / `git rebase --abort|--quit` UNDO an in-progress operation — they cannot create
// a merge commit or rewrite history, so they cannot violate the fork-point invariant this rule
// protects. They stay allowed so a repo left mid-operation (e.g. by a human-run rebase) can still be
// cleaned up. `--continue` is deliberately NOT here: it COMPLETES the operation.
const UNDO_FLAG = /--(?:abort|quit)\b/;

// Typed as a query ("would this fast-forward?"), but a successful --ff-only IS the merge.
const FF_ONLY = /--ff-only\b/;

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

export class RedirectHowToMergeMainRule extends BashRuleBase<RedirectHowToMergeMainConfig> {
    private readonly scanner = new CommandScanner();
    private readonly recovery = new TreeRecovery();
    // "Which branch does this land on?" — see branch-switch-scan.ts. It replaced a pair of regexes
    // here (`/git\s+(?:checkout|switch)\s+main\b/` and its negative-lookahead twin) that assumed the
    // branch name is the token immediately after the subcommand. One flag broke both halves at once:
    // `git checkout -q main && git pull -q origin main` missed the main EXEMPTION and then tripped the
    // feature-switch block, so this guard rejected the very command stale-main-bash-guard prescribes,
    // with a reason ("switches to a feature branch") that was the opposite of the truth.
    private readonly switches = new BranchSwitchScan(this.scanner);

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
            // `--ff-only` reads like a probe ("can I fast-forward?") but it MUTATES whenever the answer
            // is yes, so say that here — the AI that typed it was usually only trying to look.
            const probe = FF_ONLY.test(segment)
                ? ' `--ff-only` is NOT a read-only check — it moves your branch whenever it succeeds; see the read-only checks below.'
                : '';
            return this.block(ctx, segment, 'Direct `git merge`/`git rebase` is blocked — AI never runs it, on any branch.' + probe);
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
        // The two branch questions are COMPLEMENTS of one parse, so they are asked of one parse —
        // that is what keeps them from disagreeing. `git branch -D <x>` is not a checkout so it does
        // not trip this, and `git checkout -` (previous branch, unknowable at hook time) lands
        // nowhere we can name, so it counts as neither.
        const switches = this.switches.switchesIn(ctx.command);
        if (switches.some((s: BranchSwitch): boolean => !this.switches.isExistingMain(s))) {
            return this.block(ctx, segment, 'Blocked: this command switches to a feature branch and then pulls main into it.');
        }
        // The recommended `git checkout main && git pull origin main` — but ONLY in the primary
        // clone. Inside a linked worktree that checkout FATALS ("'main' is already checked out at
        // <primary>"), so waving it through here hands the AI a command that cannot work and costs
        // it a turn to discover. Steer to the fetch, which is all a worktree needs.
        if (switches.length > 0) {
            if (this.recovery.kindOf(ctx.workspaceRoot) !== 'worktree') return null;
            // block() appends updateMainSteps for the tree we are in — don't say it twice here.
            return this.block(ctx, segment, 'Blocked.');
        }

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: ctx.workspaceRoot,
            encoding: 'utf8',
        }).trim();
        if (currentBranch === 'main') return null;

        return this.block(ctx, segment, `Pulling main into feature branch '${currentBranch}' is blocked.`);
    }

    private block(ctx: BashContext, segment: string, what: string): Violation {
        // Materialize the doc we are about to send the AI to. This guard fires long before any `wp-*`
        // command runs (those are what normally write it), so the linked path could easily not exist —
        // and a STALE copy from an older @webpieces is just as misleading, hence overwrite.
        writeTemplate(ctx.workspaceRoot, INSTRUCT_FILE);
        const docPath = new RepoRootFinder().instructAiDocPath(ctx.workspaceRoot, INSTRUCT_FILE);
        // "How do I get MAIN itself current?" is a different question from "sync my feature branch",
        // and it used to have no answer anywhere on this path — the flows cover feature branches and
        // the read-only checks cover looking. An AI on main with no third option improvises, and what
        // it improvises is `git reset --hard origin/main`. Answer the question instead, shaped to the
        // tree we are actually in (in a worktree `git checkout main` fatals).
        const updateMain = [
            '',
            'On main and just wanted to bring MAIN itself up to date? That is a different question from',
            'syncing a feature branch, and merge/reset is not the answer to it:',
            ...this.recovery.updateMainSteps(this.recovery.kindOf(ctx.workspaceRoot)),
        ].join('\n');
        return new V(
            1,
            truncate(segment),
            `${what} Use the gated 3-point flow instead: 'pnpm wp-start-update' → 'pnpm wp-finish-update' when NO PR is open, or 'pnpm wp-start-upsert-pr' → 'pnpm wp-finish-upsert-pr' when a PR IS open (required then — the merge rewrites the branch and the PR must be re-pointed in the same run). If you truly need a raw merge/rebase, ask the HUMAN to run it — and warn them to push back. Full flow: READ ${docPath}.${updateMain}`,
        );
    }
}
