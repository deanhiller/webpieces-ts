import * as fs from 'fs';
import * as path from 'path';
import {
    AgedTreeSweeper, DotWebpieces, RETENTION_DAYS, RepoRootFinder, SweepCount,
    TMP_SCRATCH_RETENTION_DAYS, TmpScratchSweeper, dotWebpieces,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * 30-day garbage collection of this tree's `.webpieces` scratch state.
 *
 * Runs at the end of every merge/PR flow (see merge-end.ts). Any file older than the cutoff is deleted
 * and any directory left empty afterwards is pruned; the root itself is never removed.
 *
 * Everything the tooling still needs is rewritten on each run under a fresh mtime (instruct-ai/ docs,
 * the active logs, the *-status.json state files), and every writer `mkdirSync(..., { recursive: true })`s
 * its target first — so pruning a stale home dir is harmless; the next write recreates it.
 *
 * The roots are the two PER-WORKTREE scopes — `DotWebpieces.local()` and `DotWebpieces.aiWritable()` —
 * which are one and the same directory in the primary clone and two in a linked worktree (see
 * `aiWritable()` for why `pr-review/` has to sit in the worktree). The repo-wide `shared()` dir is never
 * swept: its entries belong to every worktree at once.
 * This used to sweep a second, machine-global root (`~/.webpieces/prs/...`, which survived `rm -rf <clone>`
 * and so had no other owner). That store is gone — the gated merge body is the PR's own description now.
 * See `decisions/0005-the-pr-description-is-the-merge-body.md`.
 *
 * ─── That removal came with a claim that was false, and this is the correction ─────────────────────
 * This docblock used to end "and with it the only artifact webpieces ever wrote outside a repo". It was
 * not: every `packages/tooling/**` spec mints its fixture with `fs.mkdtempSync(os.tmpdir(), 'wp-...')`,
 * and so did two runtime paths. Nothing reaped any of them, and because THIS comment asserted there was
 * nothing out there to reap, nobody went looking. Measured on one developer machine: 270,200 abandoned
 * `wp-*` directories in `$TMPDIR`.
 *
 * The fix is ownership at the call site — `SpecTempDirs` for fixtures, `RepoScratchDirs` (which lands
 * under the `.webpieces` scope swept below) for the two runtime paths. `TmpScratchSweeper` is the
 * backstop for the residue an exit handler cannot cover: a SIGKILLed worker, a lost power rail.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanTmp {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly sweeper: AgedTreeSweeper,
        private readonly tmpSweeper: TmpScratchSweeper,
        private readonly dotDir: DotWebpieces = dotWebpieces,
    ) {}

    async cleanTmp(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // The two per-worktree scopes, and only those. It must never sweep the repo-wide dir, whose
        // entries (merged-branches.json, the main-sync status and its lock) belong to every worktree at
        // once. In the primary clone these collapse to the same path and it is swept once.
        //   local()      — merge-info/, instruct-ai/, logs/ in <primary>/.webpieces/worktrees/<name>
        //   aiWritable() — pr-review/ in <worktree>/.webpieces, where the agent can actually write it
        const bases = this.sweepBases(repoRoot);
        if (bases.length === 0) return;

        process.stdout.write('\n' + SEP + '🧹 Garbage-Collecting .webpieces\n' + SEP + '\n');
        for (const base of bases) process.stdout.write(`Location: ${base}\n`);
        process.stdout.write(`Retention: ${RETENTION_DAYS} days (older files reaped; empty dirs pruned)\n\n`);

        const cutoffMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const total = new SweepCount();
        for (const base of bases) total.add(this.sweeper.sweep(base, cutoffMs, this.reporter(base)));

        // The `$TMPDIR` backstop. Counted into the same total so one line reports one cleanup, and run
        // last because it is the only part that touches a directory webpieces does not own.
        const tmpCutoffMs = TMP_SCRATCH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        total.add(this.tmpSweeper.sweep(tmpCutoffMs, (removed: string): void => {
            process.stdout.write(`  🗑️  dir:   ${removed}/\n`);
        }));

        if (total.empty) {
            process.stdout.write(`  ✅ Nothing older than ${RETENTION_DAYS} days; no empty directories\n`);
        } else {
            const fileWord = total.files === 1 ? 'file' : 'files';
            const dirWord = total.dirs === 1 ? 'directory' : 'directories';
            process.stdout.write(`\n  ✅ Reaped ${total.files} old ${fileWord} and pruned ${total.dirs} empty ${dirWord}\n`);
        }

        process.stdout.write('\n' + SEP + '\n');
    }

    /**
     * The per-worktree roots that exist, de-duplicated. `local()` and `aiWritable()` are the SAME path
     * in the primary clone — sweeping it twice would double-count and print every removal twice — and
     * two different paths in a linked worktree, where BOTH need reaping or `pr-review/` accumulates in
     * the worktree forever.
     */
    private sweepBases(repoRoot: string): string[] {
        const candidates = [this.dotDir.local(repoRoot), this.dotDir.aiWritable(repoRoot)];
        const seen = new Set<string>();
        return candidates.filter((base: string): boolean => {
            if (seen.has(base) || !fs.existsSync(base)) return false;
            seen.add(base);
            return true;
        });
    }

    // One line per removal, relative to the root it came from, so the two roots read as one report.
    private reporter(base: string): (removed: string, isDir: boolean) => void {
        return (removed: string, isDir: boolean): void => {
            const label = isDir ? 'dir:  ' : 'file: ';
            process.stdout.write(`  🗑️  ${label} ${path.relative(base, removed)}${isDir ? '/' : ''}\n`);
        };
    }
}
