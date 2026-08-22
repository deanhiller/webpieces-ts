import { injectable, bindingScopeValues } from 'inversify';
import {
    OrphanDirSweeper,
    RepoRootFinder,
    dotWebpieces,
} from '@webpieces/rules-config';

import { CleanupCommand } from './cleanup-command';
import {
    CleanupOptions,
    DeleteSelection,
    FLAG_DELETE_BRANCHES,
    FLAG_DELETE_WORKTREES,
} from './cleanup-options';
import { MainCheckout, StashedFiles } from './main-checkout';
import { WorkingTreeGate, UntrackedFiles } from './working-tree-gate';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-checkout-clean-main` — go to main, get main, and take out the trash. ONE command, because the three
 * are one intention and splitting them is what let the third never happen.
 *
 * ─── ITS RELATIONSHIP TO `git checkout main && git pull origin main` (READ BEFORE "DELETING" THAT) ────
 * That pair was already the enforced spelling: bare `git checkout main` is blocked precisely so the pull
 * rides along. This command is the same pairing with cleanup and the sweep welded on, and the WORKFLOW
 * messages now prescribe this instead — two spellings where one sweeps and one does not is shim shape
 * #1, an agent types whichever is accepted and the corpses accumulate forever.
 *
 * The raw pair is NOT deleted, and the reason is a constraint that outranks the shim rule: it is a
 * TERMINAL ENTRY ON THE L0 ALLOWLIST (`CHECKOUT_MAIN_PULL_CMD` in ai-hook-rules
 * `src/bin/l0-allowlist.ts`, consumed as an L0 cure in `src/core/l0-matrix.ts`) — one of
 * the few commands still permitted while an L0 block denies every other tool call. In exactly that
 * state, `node_modules` is the thing that is untrustworthy, so a `pnpm wp-*` bin is the one kind of cure
 * that cannot be relied on to run. The same reasoning covers the L0 shim's own fix option in
 * `templates/ai-hook.sh` (rendered from `src/bin/shim-drift-fix.ts`).
 *
 * So the end state is TWO LAYERS, not a deletion, and it is now in place:
 *   • L0 recovery (l0-allowlist, shim-drift-fix, l0-matrix) → keeps the raw pair. It is not a shim
 *     there; it is the only thing that works when the package manager's output is what is in doubt.
 *   • the WORKFLOW layer (stale-main-bash-guard's preferred cure, merged-branch-message/-bash-guard,
 *     TreeRecovery's cleanupSteps and updateMainSteps, the L2 rows/doc, CLAUDE.md's "Finishing a
 *     Feature") → prescribes `pnpm wp-checkout-clean-main`, and no longer prints the pair.
 *
 * The pair remains ALLOWED as a Bash command in both layers — this changed what the guards TEACH, not
 * what they permit. Blocking it would have deleted the L0 escape along with the shim.
 *
 * ─── WHY GOING TO MAIN IS THE RIGHT MOMENT TO SWEEP ───────────────────────────────────────────────────
 * The corpses appear when git moves the working tree onto a base where the tracked files under some
 * directory are gone. Landing a PR and returning to main is when every developer does that, on every
 * clone, roughly once per merged PR — so a sweep bolted here converges the whole team's machines with no
 * new trigger, no git hook to distribute, and no background daemon. It is also the quietest moment in the
 * day to move directories: nothing is building, no dev server is watching files.
 *
 * ─── WHY THE ORDER IS FIXED AND NOT PARALLEL ──────────────────────────────────────────────────────────
 * Cleanup runs BEFORE the sweep and not beside it. `wp-cleanup` removes dead worktrees, which changes
 * what is on disk, and a scan racing that would be reading a tree mid-demolition. The scan is one
 * ignore-walk and costs about a second; there is no wall-clock worth buying with that race.
 */
@injectable(bindingScopeValues.Singleton)
export class CheckoutCleanMainCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly cleanupCommand: CleanupCommand,
        private readonly orphanDirSweeper: OrphanDirSweeper,
        private readonly workingTreeGate: WorkingTreeGate,
        private readonly mainCheckout: MainCheckout,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        process.stdout.write(`${SEP}🧹 Checkout main, pull, clean\n${SEP}\n`);
        if (this.isLinkedWorktree(repoRoot)) {
            await this.sweepOnly(repoRoot);
            return;
        }
        const untracked = this.workingTreeGate.assertNoTrackedChanges(repoRoot);
        const stashed = this.mainCheckout.goToMain(repoRoot, untracked);
        this.reportUntracked(untracked, stashed);
        // No flags: this is the "go to main and take out the trash" path, so cleanup behaves exactly as a
        // bare `pnpm wp-cleanup` does here — reap what is provably dead and every zero-commit husk, ask
        // (or report) about the rest. Spelled out rather than defaulted so that if CleanupOptions ever
        // grows a field, this call site is a compile error instead of a silent old behaviour.
        await this.cleanupCommand.run(new CleanupOptions(
            new DeleteSelection(FLAG_DELETE_BRANCHES, false, ''),
            new DeleteSelection(FLAG_DELETE_WORKTREES, false, ''),
            false, false));
        this.sweep(repoRoot);
        this.reportStashed(stashed);
    }

    /**
     * A linked worktree has no main to check out — `git checkout main` FATALS there with "main is already
     * checked out at <primary clone>", which is a footgun CLAUDE.md currently has to warn about in prose.
     * So the command does the half that IS meaningful here (worktrees accumulate corpses too, if a
     * long-lived one keeps merging main in) and says plainly where the other half lives.
     */
    private async sweepOnly(repoRoot: string): Promise<void> {
        process.stdout.write(
            'This is a linked WORKTREE. main is checked out in the primary clone, so there is nothing\n'
            + 'here to check out or pull — sweeping this tree only.\n\n'
            + 'Most worktrees never need this: `wp-cleanup` removes the whole directory once its branch\n'
            + 'lands, which takes any orphan directories inside it along. Run this command again from the\n'
            + 'primary clone to go to main there.\n\n');
        this.sweep(repoRoot);
        return Promise.resolve();
    }

    private isLinkedWorktree(repoRoot: string): boolean {
        const dirs = dotWebpieces.gitDirs(repoRoot);
        return dirs !== null && dirs.isLinkedWorktree;
    }

    /**
     * Say which untracked files were let through, AFTER the move — so nobody has to wonder whether the
     * files still sitting in their tree came along for the ride. Printed rather than refused on: see
     * `WorkingTreeGate` for why an untracked file is not the hazard a tracked one is.
     *
     * Silent when the checkout had to stash: those files are NOT sitting in the tree any more, and
     * "nothing about them changed" would be a lie. `reportStashed` speaks for that case instead.
     */
    private reportUntracked(untracked: UntrackedFiles, stashed: StashedFiles): void {
        if (!stashed.isEmpty()) return;
        const rendered = untracked.render();
        if (rendered === '') return;
        process.stdout.write(`\n${rendered}`);
    }

    /**
     * The stash banner goes LAST, on purpose. It is the one thing in this command's output a reader
     * must not miss — their files left the working tree — and the cleanup and sweep that follow the
     * checkout print enough to scroll it away if it were emitted where it happened.
     */
    private reportStashed(stashed: StashedFiles): void {
        const rendered = stashed.render();
        if (rendered === '') return;
        process.stdout.write(`\n${rendered}`);
    }

    /**
     * Sweep, then print. Never throws: the checkout and pull above already succeeded, and a tidier is not
     * permitted to turn somebody's completed sync into a failed command.
     */
    private sweep(repoRoot: string): void {
        const report = this.orphanDirSweeper.sweep(repoRoot, new Date());
        const rendered = report.render();
        if (rendered === '') return;
        process.stdout.write(`\n${rendered}`);
    }
}
