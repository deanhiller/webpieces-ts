import * as fs from 'fs';
import * as path from 'path';
import {
    AgedTreeSweeper, DotWebpieces, RETENTION_DAYS, RepoRootFinder, dotWebpieces,
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
 * There is exactly ONE root, because there is exactly one place webpieces writes state: `{repo}/.webpieces`.
 * This used to sweep a second, machine-global root (`~/.webpieces/prs/...`, which survived `rm -rf <clone>`
 * and so had no other owner). That store is gone — the gated merge body is the PR's own description now —
 * and with it the only artifact webpieces ever wrote outside a repo. See
 * `decisions/0005-the-pr-description-is-the-merge-body.md`.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanTmp {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly sweeper: AgedTreeSweeper,
        private readonly dotDir: DotWebpieces = dotWebpieces,
    ) {}

    async cleanTmp(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // LOCAL scope: a worktree garbage-collects its OWN merge-info/pr-review scratch dirs. It must
        // never sweep the repo-wide dir, whose entries (merged-branches.json, the main-sync status and
        // its lock) belong to every worktree at once.
        const tmpBase = this.dotDir.local(repoRoot);
        if (!fs.existsSync(tmpBase)) return;

        process.stdout.write('\n' + SEP + '🧹 Garbage-Collecting .webpieces\n' + SEP + '\n');
        process.stdout.write(`Location: ${tmpBase}\n`);
        process.stdout.write(`Retention: ${RETENTION_DAYS} days (older files reaped; empty dirs pruned)\n\n`);

        const cutoffMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const total = this.sweeper.sweep(tmpBase, cutoffMs, this.reporter(tmpBase));

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
