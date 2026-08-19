import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';
import {
    CliExitError,
    OrphanDirSweeper,
    RepoRootFinder,
    dotWebpieces,
} from '@webpieces/rules-config';

import { CleanupCommand } from './cleanup-command';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-checkout-clean-main` — go to main, get main, and take out the trash. ONE command, because the three
 * are one intention and splitting them is what let the third never happen.
 *
 * ─── WHY THIS REPLACES `git checkout main && git pull origin main` OUTRIGHT ───────────────────────────
 * The pair was already the enforced spelling: bare `git checkout main` is blocked precisely so the pull
 * rides along. This command is that same pairing with the sweep welded on, and the old spelling STOPS
 * BEING ACCEPTED the moment this ships. That is not tidiness — it is the no-backwards-compatibility rule
 * in CLAUDE.md applied to a workflow instead of a type. Two spellings where one runs the sweep and the
 * other does not is exactly shim shape #1: an agent picks whichever typechecks, keeps typing the old
 * pair, and the orphan directories go on accumulating on every clone forever.
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
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        process.stdout.write(`${SEP}🧹 Checkout main, pull, clean\n${SEP}\n`);
        if (this.isLinkedWorktree(repoRoot)) {
            await this.sweepOnly(repoRoot);
            return;
        }
        this.assertTreeIsClean(repoRoot);
        this.goToMain(repoRoot);
        await this.cleanupCommand.run();
        this.sweep(repoRoot);
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
     * Refuse on a dirty tree instead of carrying the changes onto main. `git checkout` would happily
     * bring uncommitted work along, and the one place nobody wants to discover their work is on main.
     */
    private assertTreeIsClean(repoRoot: string): void {
        const status = this.git(repoRoot, ['status', '--porcelain']);
        if (status === null || status.trim() === '') return;
        throw new CliExitError(1,
            `${SEP}❌ Uncommitted or untracked changes\n${SEP}\n`
            + 'Going to main would carry them along. Commit them on this branch, or stash them, then\n'
            + 're-run. The webpieces tooling never commits your work for you.\n\n'
            + `${status}`);
    }

    /**
     * Checkout main and fast-forward it. `--ff-only` rather than a `reset --hard`, deliberately: a
     * developer or an agent that accidentally committed to local main would have that work silently
     * destroyed by a reset, and the whole point of this command is that it is safe to run without
     * thinking. A refusal to fast-forward is a real condition a human should see and decide about.
     */
    private goToMain(repoRoot: string): void {
        this.run_(repoRoot, ['fetch', 'origin', 'main']);
        if (this.run_(repoRoot, ['checkout', 'main']) !== 0) {
            throw new CliExitError(1, `${SEP}❌ Could not check out main\n${SEP}\n`
                + 'git refused the checkout — its message is above.\n');
        }
        if (this.run_(repoRoot, ['pull', '--ff-only', 'origin', 'main']) !== 0) {
            throw new CliExitError(1, `${SEP}❌ Local main could not fast-forward\n${SEP}\n`
                + 'Local main has commits that origin/main does not, so it is not a clean copy of the\n'
                + 'remote. Nothing was reset — those commits may be the only copy. Inspect them with\n'
                + '`git log origin/main..main` and decide what they are before going further.\n');
        }
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

    /** Captured git output, or null when git could not be run or exited non-zero. */
    private git(repoRoot: string, args: string[]): string | null {
        const result = spawnSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (result.error !== undefined || result.status !== 0) return null;
        return result.stdout;
    }

    /** git with its output going straight to the terminal — for the commands whose progress is the point. */
    private run_(repoRoot: string, args: string[]): number {
        const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: 'inherit' });
        return result.status === null ? 1 : result.status;
    }
}
