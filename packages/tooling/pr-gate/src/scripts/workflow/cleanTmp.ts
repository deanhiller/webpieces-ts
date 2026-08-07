import * as fs from 'fs';
import * as path from 'path';
import {
    AgedTreeSweeper, DotWebpieces, PrBodyStore, RETENTION_DAYS, RepoRootFinder, SweepCount, dotWebpieces,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * 30-day garbage collection of the whole `.webpieces` tree, AND of the machine-global PR-body store.
 *
 * Runs at the end of every merge/PR flow (see merge-end.ts). Both roots get the identical policy from
 * the identical implementation (`AgedTreeSweeper`): any file older than the cutoff is deleted, and any
 * directory left empty afterwards is pruned. Neither root itself is ever removed.
 *
 * Everything the tooling still needs is rewritten on each run under a fresh mtime (instruct-ai/ docs,
 * the active logs, the *-status.json state files, and an open PR's merge body), and every writer
 * `mkdirSync(..., { recursive: true })`s its target first — so pruning a stale home dir is harmless;
 * the next write recreates it.
 *
 * The SECOND root is the one with no other owner. `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/` survives
 * `rm -rf <clone>`, so if this sweep did not reap it nothing ever would (`decisions/0001` § O3). It is
 * swept from here — the one command that already runs at the end of every flow — rather than from a new
 * mechanism, because a retention policy nobody runs is not a retention policy.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanTmp {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly prBodies: PrBodyStore,
        private readonly sweeper: AgedTreeSweeper,
        private readonly dotDir: DotWebpieces = dotWebpieces,
    ) {}

    async cleanTmp(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // LOCAL scope: a worktree garbage-collects its OWN merge-info/pr-review scratch dirs. It must
        // never sweep the repo-wide dir, whose entries (merged-branches.json, the main-sync status and
        // its lock) belong to every worktree at once.
        const tmpBase = this.dotDir.local(repoRoot);
        const prsRoot = this.prBodies.prsRoot(repoRoot);
        if (!fs.existsSync(tmpBase) && !fs.existsSync(prsRoot)) return;

        process.stdout.write('\n' + SEP + '🧹 Garbage-Collecting .webpieces\n' + SEP + '\n');
        process.stdout.write(`Location: ${tmpBase}\n`);
        process.stdout.write(`          ${prsRoot}  (machine-global PR merge bodies)\n`);
        process.stdout.write(`Retention: ${RETENTION_DAYS} days (older files reaped; empty dirs pruned)\n\n`);

        const cutoffMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const total = new SweepCount();
        total.add(this.sweeper.sweep(tmpBase, cutoffMs, this.reporter(tmpBase)));
        total.add(this.prBodies.sweep(repoRoot, this.reporter(prsRoot)));

        if (total.empty) {
            process.stdout.write(`  ✅ Nothing older than ${RETENTION_DAYS} days; no empty directories\n`);
        } else {
            const fileWord = total.files === 1 ? 'file' : 'files';
            const dirWord = total.dirs === 1 ? 'directory' : 'directories';
            process.stdout.write(`\n  ✅ Reaped ${total.files} old ${fileWord} and pruned ${total.dirs} empty ${dirWord}\n`);
        }

        process.stdout.write('\n' + SEP + '\n');
    }

    // One line per removal, relative to the root it came from, so the two roots read as one report.
    private reporter(base: string): (removed: string, isDir: boolean) => void {
        return (removed: string, isDir: boolean): void => {
            const label = isDir ? 'dir:  ' : 'file: ';
            process.stdout.write(`  🗑️  ${label} ${path.relative(base, removed)}${isDir ? '/' : ''}\n`);
        };
    }
}
