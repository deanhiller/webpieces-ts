import * as fs from 'fs';
import * as path from 'path';
import { WEBPIECES_TMP_DIR, RepoRootFinder } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const CUTOFF_DAYS = 30;
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Result of one sweep: how many files were reaped for age, and how many now-empty dirs were pruned.
class SweepResult {
    constructor(
        public files: number,
        public dirs: number,
    ) {}
}

/**
 * 30-day garbage collection of the whole `.webpieces` tree.
 *
 * Runs at the end of every merge/PR flow (see merge-end.ts). It walks `.webpieces` depth-first and:
 *   1. deletes ANY file whose mtime is older than the cutoff, anywhere in the tree, and
 *   2. removes ANY directory that is left empty afterwards (including dirs that were already empty).
 *
 * The `.webpieces` root itself is never removed. Everything the tooling still needs is rewritten on
 * each run under a fresh mtime (instruct-ai/ docs, the active hooks/ logs, the *-status.json state
 * files), and every writer `mkdirSync(..., { recursive: true })`s its target first — so pruning a
 * stale home dir is harmless; the next write recreates it. Stale per-feature merge-info/pr-review
 * subdirs and the retired legacy flat layout all fall out of this single pass with no special-casing.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanTmp {
    constructor(private readonly repoRootFinder: RepoRootFinder) {}

    async cleanTmp(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const tmpBase = path.join(repoRoot, WEBPIECES_TMP_DIR);

        if (!fs.existsSync(tmpBase)) {
            return;
        }

        process.stdout.write('\n');
        process.stdout.write(SEP);
        process.stdout.write('🧹 Garbage-Collecting .webpieces\n');
        process.stdout.write(SEP);
        process.stdout.write('\n');
        process.stdout.write(`Location: ${tmpBase}\n`);
        process.stdout.write(`Retention: ${CUTOFF_DAYS} days (older files reaped; empty dirs pruned)\n`);
        process.stdout.write('\n');

        const cutoffMs = CUTOFF_DAYS * 24 * 60 * 60 * 1000;
        const now = Date.now();

        // `true` => this is the root, which is swept into but never itself removed. This generic
        // depth-first sweep needs NO knowledge of the merge-info layout — including the new
        // staged/<feature> and merged/<feature> split, which sits one level deeper than the old
        // per-feature dirs. That is precisely why it replaced the per-home special-casing.
        const result = this.sweep(tmpBase, tmpBase, now, cutoffMs, true);

        if (result.files === 0 && result.dirs === 0) {
            process.stdout.write(`  ✅ Nothing older than ${CUTOFF_DAYS} days; no empty directories\n`);
        } else {
            const fileWord = result.files === 1 ? 'file' : 'files';
            const dirWord = result.dirs === 1 ? 'directory' : 'directories';
            process.stdout.write('\n');
            process.stdout.write(`  ✅ Reaped ${result.files} old ${fileWord} and pruned ${result.dirs} empty ${dirWord}\n`);
        }

        process.stdout.write('\n');
        process.stdout.write(SEP);
        process.stdout.write('\n');
    }

    // Depth-first, post-order sweep of `dir` (rooted at `tmpBase`, only used for tidy relative logging).
    // Files older than the cutoff are deleted; a directory left empty once its children are processed is
    // pruned — except the root, which is kept even when empty so `.webpieces/` itself survives.
    private sweep(dir: string, tmpBase: string, now: number, cutoffMs: number, isRoot: boolean): SweepResult {
        let files = 0;
        let dirs = 0;

        for (const entry of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, entry);
            // lstat, not stat: a symlink is treated as a leaf (aged out like a file), never followed —
            // so we can never wander outside `.webpieces` or delete a link target elsewhere.
            const stat = fs.lstatSync(fullPath);
            if (stat.isDirectory()) {
                const nested = this.sweep(fullPath, tmpBase, now, cutoffMs, false);
                files += nested.files;
                dirs += nested.dirs;
            } else if (now - stat.mtimeMs >= cutoffMs) {
                process.stdout.write(`  🗑️  file:  ${path.relative(tmpBase, fullPath)}\n`);
                fs.rmSync(fullPath, { force: true });
                files += 1;
            }
        }

        // Post-order: prune this dir if reaping its children (or nothing) left it empty.
        if (!isRoot && fs.readdirSync(dir).length === 0) {
            process.stdout.write(`  🗑️  dir:   ${path.relative(tmpBase, dir)}/\n`);
            fs.rmdirSync(dir);
            dirs += 1;
        }

        return new SweepResult(files, dirs);
    }
}
