import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WEBPIECES_TMP_DIR, MERGE_INFO_DIR, PR_INFO_DIR } from '@webpieces/rules-config';

const CUTOFF_DAYS = 30;
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Per-feature workflow dirs now live under `.webpieces/merge-info/<feature>` and
// `.webpieces/pr-info/<feature>`; those two homes are permanent (like hooks/ and instruct-ai/) and
// only their stale subdirs are cleaned. `LEGACY_PREFIXES` sweeps the old flat top-level layout
// (`merge-<feature>`/`review-<feature>`/`pr-<feature>`) so it self-clears after the move.
const LEGACY_PREFIXES = ['merge-', 'review-', 'pr-'];

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const tmpBase = path.join(repoRoot, WEBPIECES_TMP_DIR);

    if (!fs.existsSync(tmpBase)) {
        return;
    }

    process.stdout.write('\n');
    process.stdout.write(SEP);
    process.stdout.write('🧹 Cleaning Old Temporary Directories\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');
    process.stdout.write(`Location: ${tmpBase}\n`);
    process.stdout.write(`Retention: ${CUTOFF_DAYS} days\n`);
    process.stdout.write('\n');

    const cutoffMs = CUTOFF_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    // Stale per-feature subdirs under each permanent home.
    deletedCount += cleanStaleSubdirs(path.join(tmpBase, MERGE_INFO_DIR), MERGE_INFO_DIR, now, cutoffMs);
    deletedCount += cleanStaleSubdirs(path.join(tmpBase, PR_INFO_DIR), PR_INFO_DIR, now, cutoffMs);
    // Legacy flat top-level dirs from before the merge-info/pr-info nesting.
    deletedCount += cleanLegacyTopLevel(tmpBase, now, cutoffMs);

    if (deletedCount === 0) {
        process.stdout.write(`  ✅ No directories older than ${CUTOFF_DAYS} days found\n`);
    } else {
        process.stdout.write('\n');
        process.stdout.write(`  ✅ Deleted ${deletedCount} old director${deletedCount === 1 ? 'y' : 'ies'}\n`);
    }

    process.stdout.write('\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');
}

// Delete immediate subdirs of `parentDir` whose mtime is older than the cutoff. `label` prefixes
// the printed path so output reads e.g. `merge-info/dean-foo`. No-op if the home doesn't exist.
function cleanStaleSubdirs(parentDir: string, label: string, now: number, cutoffMs: number): number {
    if (!fs.existsSync(parentDir)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(parentDir)) {
        const fullPath = path.join(parentDir, entry);
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs < cutoffMs) continue;
        process.stdout.write(`  🗑️  Deleting: ${label}/${entry}\n`);
        fs.rmSync(fullPath, { recursive: true, force: true });
        count += 1;
    }
    return count;
}

// Sweep the pre-nesting flat layout (`merge-<feature>` etc.), skipping the current homes (whose
// names also start with `merge-`/`pr-`) so this never deletes merge-info/ or pr-info/ themselves.
function cleanLegacyTopLevel(tmpBase: string, now: number, cutoffMs: number): number {
    let count = 0;
    for (const entry of fs.readdirSync(tmpBase)) {
        if (entry === MERGE_INFO_DIR || entry === PR_INFO_DIR) continue;
        if (!LEGACY_PREFIXES.some((prefix: string): boolean => entry.startsWith(prefix))) continue;
        const fullPath = path.join(tmpBase, entry);
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs < cutoffMs) continue;
        process.stdout.write(`  🗑️  Deleting: ${entry}\n`);
        fs.rmSync(fullPath, { recursive: true, force: true });
        count += 1;
    }
    return count;
}

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
