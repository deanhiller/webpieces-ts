#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { main as gatherInfo } from './git-gatherInfo';
import { main as cleanTmp } from './workflow/cleanTmp';
import { runGitChecked } from './workflow/git-exec';
import {
    MergeMarker,
    mergeDirFor,
    readMergeMarker,
    writeMergeMarker,
    clearMergeMarker,
} from './workflow/merge-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

interface HashPoints {
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
}

function detectPr(currentBranch: string): string {
    const result = spawnSync(
        'gh', ['pr', 'list', '--head', currentBranch, '--json', 'number', '--jq', '.[0].number'],
        { encoding: 'utf8' },
    );
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

function createBackup(currentBranch: string): string {
    process.stdout.write('\n' + SEP + '💾 Creating Incremental Backup\n' + SEP + '\n');
    let n = 1;
    while (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${currentBranch}Backup${n}`]).status === 0) {
        n += 1;
    }
    const backupBranch = `${currentBranch}Backup${n}`;
    runGitChecked(['checkout', '-b', backupBranch], 'Failed to create backup branch');
    runGitChecked(['checkout', currentBranch], 'Failed to return to feature branch');
    process.stdout.write(`✅ Backup created: ${backupBranch}\n\n`);
    return backupBranch;
}

function saveConflictContext(
    conflictedFiles: string[], mergeDir: string, forkPoint: string, featureHead: string, mainHead: string,
): void {
    for (const file of conflictedFiles) {
        const safePath = file.replace(/\//g, '__');
        const fileDir = path.join(mergeDir, `updatemain-${safePath}`);
        fs.mkdirSync(fileDir, { recursive: true });

        const fork = spawnSync('git', ['show', `${forkPoint}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'A-forkpoint.txt'), fork.status === 0 ? (fork.stdout ?? '') : '(file did not exist)\n');
        const feature = spawnSync('git', ['show', `${featureHead}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'B-feature.txt'), feature.status === 0 ? (feature.stdout ?? '') : '(file did not exist)\n');
        const main = spawnSync('git', ['show', `${mainHead}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'C-main.txt'), main.status === 0 ? (main.stdout ?? '') : '(file did not exist)\n');

        const ba = spawnSync('git', ['diff', forkPoint, featureHead, '--', file], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'B-A.diff'), ba.stdout ?? '');
        const ca = spawnSync('git', ['diff', forkPoint, mainHead, '--', file], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'C-A.diff'), ca.stdout ?? '');
    }
}

function printConflictHandback(mergeDir: string, squashBranch: string, conflictedFiles: string[]): void {
    process.stdout.write('\n' + SEP + `⚠️  Conflicts in ${conflictedFiles.length} file(s) — handing control back to you\n` + SEP + '\n');
    process.stdout.write(`You are on branch ${squashBranch} with conflicts in the working tree.\n`);
    process.stdout.write(`3-point context per file in: ${mergeDir}/updatemain-<file>/\n`);
    process.stdout.write('  A-forkpoint.txt (base) · B-feature.txt (yours) · C-main.txt (main) · B-A.diff · C-A.diff\n\n');
    process.stdout.write('RESOLVE NOW (in the working tree):\n');
    process.stdout.write('  1. Edit each conflicted file, combining your changes (B−A) with main\'s (C−A).\n');
    process.stdout.write('  2. Do NOT git commit / git push / gh pr — these are blocked until validated.\n');
    process.stdout.write('  3. When every file is resolved, run:  pnpm wp-git-merge-complete\n');
    process.stdout.write('     (runs the conflict-marker scan + build; commits only if green)\n');
    process.stdout.write('  4. Then re-run  pnpm wp-upsert-pr  (or pnpm wp-git-update) to finalize & push.\n\n');
    process.stdout.write('Conflicted files:\n');
    for (const file of conflictedFiles) process.stdout.write(`  - ${file}\n`);
    process.stdout.write('\n' + SEP);
}

function handleConflictsHandback(
    mergeDir: string, currentBranch: string, squashBranch: string,
    backupBranch: string, prNumber: string, hashes: HashPoints,
): void {
    const raw = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    const conflictedFiles = raw.split('\n').filter((f: string): boolean => f.trim() !== '');
    fs.writeFileSync(path.join(mergeDir, 'updatemain-conflicted-files.txt'), raw + '\n');
    saveConflictContext(conflictedFiles, mergeDir, hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead);

    const marker = new MergeMarker(
        currentBranch, squashBranch, backupBranch, prNumber, conflictedFiles,
        hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead, false,
    );
    writeMergeMarker(mergeDir, marker);
    printConflictHandback(mergeDir, squashBranch, conflictedFiles);
    process.exit(2);
}

function finalizeBranch(
    currentBranch: string, squashBranch: string, backupBranch: string, prNumber: string,
): void {
    process.stdout.write('\n' + SEP + '🗑️  Finalizing\n' + SEP + '\n');
    runGitChecked(['branch', '-D', currentBranch], 'Failed to delete old feature branch');

    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch]).status === 0;
    if (remoteExists) {
        process.stdout.write(prNumber ? `Updating PR #${prNumber} (force-with-lease)...\n` : 'Updating remote branch (force-with-lease)...\n');
        runGitChecked(['push', '-u', '--force-with-lease', 'origin', `${squashBranch}:${currentBranch}`], 'Failed to push to origin');
    } else {
        process.stdout.write('No remote branch — local only.\n');
    }
    runGitChecked(['checkout', squashBranch], 'Failed to checkout squash branch');
    runGitChecked(['branch', '-m', currentBranch], 'Failed to rename squash branch');

    process.stdout.write(`\n✅ Branch ${currentBranch} updated from main. Backup: ${backupBranch}\n`);
    process.stdout.write(`   Delete backup when safe: git branch -D ${backupBranch}\n\n`);
}

async function handleResume(mergeDir: string, marker: MergeMarker): Promise<void> {
    if (!marker.validated) {
        process.stdout.write('\n' + SEP + '⏸️  Merge in progress — not yet validated\n' + SEP + '\n');
        process.stdout.write('Resolve the remaining conflicts in the working tree, then run:\n');
        process.stdout.write('  pnpm wp-git-merge-complete\n\n');
        process.exit(1);
    }
    process.stdout.write('Resuming: merge validated — finalizing.\n');
    finalizeBranch(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber);
    clearMergeMarker(mergeDir);
    await cleanTmp();
}

async function runFreshUpdate(mergeDir: string): Promise<void> {
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    if (currentBranch.endsWith('Squash')) {
        process.stderr.write(`❌ On a leftover ${currentBranch} branch with no merge marker. Clean up: git branch -D ${currentBranch}\n`);
        process.exit(1);
    }

    process.stdout.write('\n' + SEP + '🔄 Squash-Merge Update from Main\n' + SEP + '\n');
    await gatherInfo();
    const hashes = JSON.parse(fs.readFileSync(path.join(mergeDir, 'updatemain-hashes.json'), 'utf8')) as HashPoints;

    const prNumber = detectPr(currentBranch);
    process.stdout.write(prNumber ? `Existing PR #${prNumber} will be updated.\n` : 'No existing PR (one can be created later).\n');

    const backupBranch = createBackup(currentBranch);
    const squashBranch = `${currentBranch}Squash`;
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${squashBranch}`]).status === 0) {
        process.stderr.write(`❌ Stale ${squashBranch} from a previous run. Delete it: git branch -D ${squashBranch}\n`);
        process.exit(1);
    }

    runGitChecked(['checkout', 'main'], 'Failed to checkout main');
    runGitChecked(['pull', 'origin', 'main'], 'Failed to pull origin/main');
    runGitChecked(['checkout', '-b', squashBranch], 'Failed to create squash branch');

    process.stdout.write('\n' + SEP + `🔀 Squash merging ${currentBranch}\n` + SEP + '\n');
    const merge = spawnSync('git', ['merge', '--squash', currentBranch], { stdio: 'inherit' });
    if (merge.status !== 0) {
        handleConflictsHandback(mergeDir, currentBranch, squashBranch, backupBranch, prNumber, hashes);
        return;
    }

    const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
    if (nothingStaged) {
        process.stdout.write('ℹ️  Already up-to-date with main (nothing to merge).\n');
    } else {
        runGitChecked(['commit', '-m', `Squash merge of ${currentBranch}`], 'Failed to commit squash merge');
    }
    finalizeBranch(currentBranch, squashBranch, backupBranch, prNumber);
    await cleanTmp();
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const featureName = getFeatureName();
    const mergeDir = mergeDirFor(repoRoot, featureName);
    fs.mkdirSync(mergeDir, { recursive: true });

    const existing = readMergeMarker(mergeDir);
    if (existing) {
        await handleResume(mergeDir, existing);
        return;
    }
    await runFreshUpdate(mergeDir);
}

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
