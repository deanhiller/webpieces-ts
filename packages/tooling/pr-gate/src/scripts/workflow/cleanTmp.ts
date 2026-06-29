import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const CUTOFF_DAYS = 30;
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const tmpBase = path.join(repoRoot, 'webpiecesTmp');

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

    const entries = fs.readdirSync(tmpBase);
    for (const entry of entries) {
        const fullPath = path.join(tmpBase, entry);
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs < cutoffMs) continue;

        process.stdout.write(`  🗑️  Deleting: ${entry}\n`);
        fs.rmSync(fullPath, { recursive: true, force: true });
        deletedCount += 1;
    }

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

if (require.main === module) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
