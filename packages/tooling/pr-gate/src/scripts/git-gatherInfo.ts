#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { findForkPoint } from './workflow/git-findForkPoint';
import { mergeDirFor } from './workflow/merge-state';
import { assertCleanTree } from './workflow/git-exec';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

interface HashPoints {
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
}

function validateCleanTree(currentBranch: string, repoRoot: string): void {
    if (currentBranch === 'main') {
        process.stderr.write('❌ Error: Already on main branch. No need to update from main.\n');
        process.exit(1);
    }
    process.stderr.write(`Current branch: ${currentBranch}\n`);
    // Require a fully-committed tree (tracked AND untracked). The old check used `git diff-index`,
    // which is tracked-only, so a stale untracked dir slipped through and was later swept into the
    // squash commit by `git add -A`. assertCleanTree uses `git status --porcelain` (untracked-aware,
    // gitignore-respecting) and aborts with instructions — the tooling never commits your work for you.
    assertCleanTree(repoRoot);
}

function printHashPoints(hashes: HashPoints, currentBranch: string, mergeDir: string): void {
    process.stderr.write('📍 The 3 Hash Points:\n');
    process.stderr.write(`  1. Fork point (A):   ${hashes.hashForkPoint}\n`);
    process.stderr.write(`     (where ${currentBranch} diverged from main)\n`);
    process.stderr.write('\n');
    process.stderr.write(`  2. Feature HEAD (B): ${hashes.hashFeatureHead}\n`);
    process.stderr.write(`     (tip of ${currentBranch})\n`);
    process.stderr.write('\n');
    process.stderr.write(`  3. Main HEAD (C):    ${hashes.hashMainHead}\n`);
    process.stderr.write('     (current origin/main)\n');
    process.stderr.write('\n');
    process.stderr.write(`Merge directory: ${mergeDir}\n`);
    process.stderr.write('\n');
}

export async function main(): Promise<void> {
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const featureName = getFeatureName();
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const mergeDir = mergeDirFor(repoRoot, featureName);
    fs.mkdirSync(mergeDir, { recursive: true });

    validateCleanTree(currentBranch, repoRoot);

    process.stderr.write('\n');
    process.stderr.write(SEP);
    process.stderr.write('📍 Gathering Merge Context\n');
    process.stderr.write(SEP);
    process.stderr.write('\n');
    process.stderr.write('Fetching latest changes from origin/main...\n');
    spawnSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });

    await findForkPoint('merge');

    const hashesFile = path.join(mergeDir, 'updatemain-hashes.json');
    const hashes = JSON.parse(fs.readFileSync(hashesFile, 'utf8')) as HashPoints;

    printHashPoints(hashes, currentBranch, mergeDir);

    if (hashes.hashForkPoint === hashes.hashMainHead) {
        process.stderr.write(SEP);
        process.stderr.write('✅ Already up to date with main!\n');
        process.stderr.write(SEP);
        process.stderr.write('\n');
        process.stderr.write('Your branch has not diverged from main.\n');
        process.stderr.write('There are no new changes from main to merge.\n');
        process.stderr.write('\n');
        process.stderr.write(SEP);
        process.exit(0);
    }

    process.stderr.write('Main has advanced. Merge will be needed.\n');
    process.stderr.write('\n');
    process.stderr.write(SEP);
    process.stderr.write('\n');
}

if (require.main === module) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
