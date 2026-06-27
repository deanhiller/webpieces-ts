#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { main as gatherInfo } from './git-gatherInfo';
import { main as cleanTmp } from './workflow/cleanTmp';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

interface WebpiecesSettings {
    ai_merge_conflicts?: boolean;
}

interface HashPoints {
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
}

function getAiMergePreference(): 'yes' | 'no' | null {
    const settingsFile = path.join(process.env['HOME'] ?? '', '.webpieces', 'settings.json');
    if (!fs.existsSync(settingsFile)) return null;
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as WebpiecesSettings;
    if (settings.ai_merge_conflicts === true) return 'yes';
    if (settings.ai_merge_conflicts === false) return 'no';
    return null;
}

function saveAiMergePreference(useAi: boolean): void {
    const settingsDir = path.join(process.env['HOME'] ?? '', '.webpieces');
    const settingsFile = path.join(settingsDir, 'settings.json');
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings: WebpiecesSettings = {};
    if (fs.existsSync(settingsFile)) {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as WebpiecesSettings;
    }
    settings.ai_merge_conflicts = useAi;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
    return new Promise<string>((resolve: (answer: string) => void) => {
        rl.question(question, resolve);
    });
}

function saveConflictContext(conflictedFiles: string[], mergeDir: string, forkPoint: string, featureHead: string, mainHead: string): void {
    for (const file of conflictedFiles) {
        const safePath = file.replace(/\//g, '__');
        const fileDir = path.join(mergeDir, `updatemain-${safePath}`);
        fs.mkdirSync(fileDir, { recursive: true });

        const forkContent = spawnSync('git', ['show', `${forkPoint}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'A-forkpoint.txt'), forkContent.status === 0 ? (forkContent.stdout ?? '') : '(file did not exist)\n');

        const featureContent = spawnSync('git', ['show', `${featureHead}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'B-feature.txt'), featureContent.status === 0 ? (featureContent.stdout ?? '') : '(file did not exist)\n');

        const mainContent = spawnSync('git', ['show', `${mainHead}:${file}`], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'C-main.txt'), mainContent.status === 0 ? (mainContent.stdout ?? '') : '(file did not exist)\n');

        const baResult = spawnSync('git', ['diff', forkPoint, featureHead, '--', file], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'B-A.diff'), baResult.stdout ?? '');

        const caResult = spawnSync('git', ['diff', forkPoint, mainHead, '--', file], { encoding: 'utf8' });
        fs.writeFileSync(path.join(fileDir, 'C-A.diff'), caResult.stdout ?? '');
    }
}

async function waitForCleanCommit(rl: readline.Interface, prompt: string): Promise<void> {
    let committed = false;
    while (!committed) {
        const ans = await askQuestion(rl, prompt);
        process.stdout.write('\n');
        if (ans.toLowerCase() === 'y') {
            const isClean = spawnSync('git', ['diff-index', '--quiet', 'HEAD', '--']).status === 0;
            if (isClean) {
                committed = true;
            } else {
                process.stdout.write('❌ You still have uncommitted changes\n\n');
            }
        }
    }
}

async function resolveAiMerge(rl: readline.Interface, repoRoot: string, mergeDir: string): Promise<void> {
    process.stdout.write('\n' + SEP + '🤖 Calling AI to Resolve Conflicts\n' + SEP + '\n');

    spawnSync('claude', [
        '--allowed-tools', 'Edit Write Read Bash Glob Grep',
        '--append-system-prompt',
        'Read .claude/commands/wp-merge.md and follow ALL instructions in that file to resolve the merge conflicts.',
        'Start resolving the merge conflicts now.',
    ], { stdio: 'inherit', cwd: repoRoot });

    process.stdout.write('\n' + SEP + '✅ AI Merge Summary ✅\n' + SEP + '\n');
    process.stdout.write('Review what I did before committing:\n');
    process.stdout.write("  1. Read each file's resolution details BELOW (quick read)\n");
    process.stdout.write('  2. Diff each file in your IDE making sure AI did nothing extra\n');
    process.stdout.write('  3. Delete any remaining A/B/C comment blocks in the code\n\n');
    process.stdout.write(`Full merge context available in: ${mergeDir}\n\n`);

    const mergeSummaryFile = path.join(mergeDir, 'merge-summary.md');
    if (fs.existsSync(mergeSummaryFile)) {
        process.stdout.write(fs.readFileSync(mergeSummaryFile, 'utf8'));
    } else {
        process.stdout.write('ℹ️  No merge summary file was generated by AI.\n');
        process.stdout.write(`   (Expected: ${mergeSummaryFile})\n`);
    }

    process.stdout.write('\n' + SEP + '⚠️  IMPORTANT: SCROLL UP to AI Merge Summary section\n' + SEP + '\n');
    process.stdout.write('When done reviewing, run:\n\n  git add -A && git commit -m "Merge main into feature branch"\n\n');

    await waitForCleanCommit(rl, 'Have you scrolled up to ✅ AI Merge Summary ✅ and done a quick read? Did you commit it per instructions? (y/n) ');
    fs.writeFileSync(path.join(mergeDir, 'conflicts-resolved'), '');
    process.stdout.write('\n' + SEP);
}

async function resolveManualMerge(rl: readline.Interface, mergeDir: string): Promise<void> {
    process.stdout.write('\n' + SEP + '🛠️  Manual Merge Required\n' + SEP + '\n');

    let committed = false;
    while (!committed) {
        process.stdout.write('Please resolve conflicts manually\n');
        process.stdout.write(`Merge context available in: ${mergeDir}\n\n`);

        const ans = await askQuestion(rl, 'Are you done merging and committing? (y/n) ');
        process.stdout.write('\n');

        if (ans.toLowerCase() === 'y') {
            const isClean = spawnSync('git', ['diff-index', '--quiet', 'HEAD', '--']).status === 0;
            if (isClean) {
                committed = true;
            } else {
                process.stdout.write('❌ You still have uncommitted changes\n\n');
            }
        }
    }
    fs.writeFileSync(path.join(mergeDir, 'conflicts-resolved'), '');
}

async function handleConflicts(currentBranch: string, mergeDir: string, hashes: HashPoints, rl: readline.Interface, repoRoot: string): Promise<void> {
    process.stdout.write('\n' + SEP + '⚠️  Conflicts Detected\n' + SEP + '\n');
    process.stdout.write('Conflicting files:\n');

    const conflictedFilesRaw = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    process.stdout.write(conflictedFilesRaw + '\n\n');

    fs.writeFileSync(path.join(mergeDir, 'updatemain-conflicted-files.txt'), conflictedFilesRaw + '\n');
    const conflictedFiles = conflictedFilesRaw.split('\n').filter((f: string) => f.trim() !== '');

    saveConflictContext(conflictedFiles, mergeDir, hashes.hashForkPoint, hashes.hashFeatureHead, hashes.hashMainHead);
    process.stdout.write(`✅ Merge context saved to: ${mergeDir}\n\n`);

    const settingsFile = path.join(process.env['HOME'] ?? '', '.webpieces', 'settings.json');
    const savedPref = getAiMergePreference();
    let useAi: boolean;

    if (savedPref !== null) {
        useAi = savedPref === 'yes';
        process.stdout.write(`Using saved preference: ${useAi ? 'AI merge' : 'Manual merge'} (from ${settingsFile})\n`);
        process.stdout.write(`To change, edit ${settingsFile} and set "ai_merge_conflicts"\n\n`);
    } else {
        process.stdout.write(SEP + `⚠️  Your choice will be saved to: ${settingsFile}\n` + '   You can edit this file later to change your preference.\n' + SEP + '\n');
        const answer = await askQuestion(rl, 'Would you like AI to help resolve conflicts? (y/n) ');
        process.stdout.write('\n');
        useAi = answer.toLowerCase() === 'y';
        saveAiMergePreference(useAi);
        process.stdout.write(`✅ Saved preference: ${useAi ? 'AI merge' : 'Manual merge'}\n\n`);
    }

    if (useAi) {
        await resolveAiMerge(rl, repoRoot, mergeDir);
    } else {
        await resolveManualMerge(rl, mergeDir);
    }

    void currentBranch;
}

function printFinalSummary(currentBranch: string, backupBranch: string, prNumber: string, mergeDir: string, hasRemote: boolean): void {
    process.stdout.write('\n' + SEP);
    if (hasRemote) {
        process.stdout.write(prNumber ? `✅ Successfully Updated PR #${prNumber}\n` : '✅ Successfully Updated Remote Branch\n');
    } else {
        process.stdout.write('✅ Branch Updated from Main\n');
    }
    process.stdout.write(SEP + '\n📋 Summary:\n');
    process.stdout.write(`  Branch: ${currentBranch}\n`);
    if (hasRemote && prNumber) {
        process.stdout.write(`  PR: #${prNumber}\n`);
    } else if (!hasRemote) {
        process.stdout.write('  Base: main (latest)\n');
    } else {
        process.stdout.write('  PR: (none found - create with gh pr create)\n');
    }
    process.stdout.write(`  Backup: ${backupBranch}\n`);
    process.stdout.write(`  Merge context: ${mergeDir}\n`);
    process.stdout.write('\nNext steps:\n');
    if (hasRemote) {
        process.stdout.write('  1. Review changes on GitHub\n');
        process.stdout.write('  2. Continue development or create more commits\n');
    } else {
        process.stdout.write('  1. Test your changes\n');
        process.stdout.write('  2. Create PR with: gh pr create\n');
    }
    process.stdout.write(`  3. Delete old backup when safe: git branch -D ${backupBranch}\n\n`);
    process.stdout.write(SEP);
}

function createBackup(currentBranch: string): string {
    process.stdout.write('\n' + SEP + '💾 Creating Incremental Backup\n' + SEP + '\n');
    let n = 1;
    while (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${currentBranch}Backup${n}`]).status === 0) {
        n += 1;
    }
    const backupBranch = `${currentBranch}Backup${n}`;
    process.stdout.write(`Creating backup: ${backupBranch}\n`);
    spawnSync('git', ['checkout', '-b', backupBranch], { stdio: 'inherit' });
    spawnSync('git', ['checkout', currentBranch], { stdio: 'inherit' });
    process.stdout.write(`✅ Backup created: ${backupBranch}\n\n`);
    return backupBranch;
}

async function finalizeBranch(currentBranch: string, squashBranch: string, backupBranch: string, prNumber: string, mergeDir: string): Promise<void> {
    process.stdout.write('\n' + SEP + '🗑️  Cleaning Up Old Branch\n' + SEP + '\n');
    process.stdout.write(`Deleting local branch: ${currentBranch} (backed up as ${backupBranch})\n`);
    spawnSync('git', ['branch', '-D', currentBranch], { stdio: 'inherit' });
    process.stdout.write('\n');

    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch]).status === 0;

    if (remoteExists) {
        process.stdout.write(SEP + (prNumber ? `🔍 Updating Existing PR #${prNumber}\n` : '🔍 Updating Remote Branch (no PR found)\n') + SEP + '\n');
        if (prNumber) {
            process.stdout.write(`✅ Updating PR #${prNumber} with squashed changes\n`);
        } else {
            process.stdout.write('⚠️  Remote branch exists but no PR found (PR check may have failed)\n   Syncing remote branch anyway...\n');
        }
        process.stdout.write(`\nForce pushing ${squashBranch} to origin/${currentBranch}...\n`);
        spawnSync('git', ['push', '-u', '--force-with-lease', 'origin', `${squashBranch}:${currentBranch}`], { stdio: 'inherit' });
        spawnSync('git', ['checkout', squashBranch], { stdio: 'inherit' });
        spawnSync('git', ['branch', '-m', currentBranch], { stdio: 'inherit' });
    } else {
        process.stdout.write(SEP + '📝 No Remote Branch to Update\n' + SEP + '\n');
        spawnSync('git', ['checkout', squashBranch], { stdio: 'inherit' });
        spawnSync('git', ['branch', '-m', currentBranch], { stdio: 'inherit' });
        process.stdout.write(`ℹ️  No remote branch found for ${currentBranch} (local only)\n\n`);
    }

    printFinalSummary(currentBranch, backupBranch, prNumber, mergeDir, remoteExists);
}

export async function main(): Promise<void> {
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const featureName = getFeatureName();
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const mergeDir = path.join(repoRoot, 'webpiecesTmp', `merge-${featureName}`);
    fs.mkdirSync(mergeDir, { recursive: true });

    process.stdout.write('\n' + SEP + '🔄 Squash-Merge Workflow\n' + SEP + '\n');
    process.stdout.write('Gathering merge context...\n');
    await gatherInfo();

    const hashes = JSON.parse(fs.readFileSync(path.join(mergeDir, 'updatemain-hashes.json'), 'utf8')) as HashPoints;

    process.stdout.write('\nChecking for existing PR...\n');
    const prResult = spawnSync('gh', ['pr', 'list', '--head', currentBranch, '--json', 'number', '--jq', '.[0].number'], { encoding: 'utf8' });
    const prNumber = prResult.status === 0 ? (prResult.stdout ?? '').trim() : '';
    process.stdout.write(prNumber ? `✅ Found existing PR #${prNumber} (will be updated after merge)\n\n` : 'ℹ️  No existing PR found (you can create one later with gh pr create)\n\n');

    const backupBranch = createBackup(currentBranch);

    process.stdout.write(SEP + '🔄 Creating Temporary Squash Branch\n' + SEP + '\n');
    const squashBranch = `${currentBranch}Squash`;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${squashBranch}`]).status === 0) {
        process.stdout.write(`⚠️  Found existing ${squashBranch} from previous run\n`);
        const answer = await askQuestion(rl, 'Delete and start fresh? (y/n) ');
        process.stdout.write('\n');
        if (answer.toLowerCase() === 'y') {
            spawnSync('git', ['branch', '-D', squashBranch], { stdio: 'inherit' });
        } else {
            process.stdout.write('❌ Aborting. Please clean up manually.\n');
            rl.close();
            process.exit(1);
        }
    }

    process.stdout.write('Updating local main branch...\n');
    spawnSync('git', ['checkout', 'main'], { stdio: 'inherit' });
    spawnSync('git', ['pull', 'origin', 'main'], { stdio: 'inherit' });
    process.stdout.write(`Creating new branch: ${squashBranch} from main...\n\n`);
    spawnSync('git', ['checkout', '-b', squashBranch], { stdio: 'inherit' });

    process.stdout.write(SEP + `🔀 Squash Merging ${currentBranch}\n` + SEP + '\n');
    const mergeResult = spawnSync('git', ['merge', '--squash', currentBranch], { stdio: 'inherit' });

    if (mergeResult.status === 0) {
        process.stdout.write('\n✅ Squash merge successful (no conflicts)\n\n');
        const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
        if (nothingStaged) {
            process.stdout.write('ℹ️  Branch already up-to-date with main (nothing to merge)\n');
        } else {
            spawnSync('git', ['commit', '-m', `Squash merge of ${currentBranch}`], { stdio: 'inherit' });
        }
    } else {
        await handleConflicts(currentBranch, mergeDir, hashes, rl, repoRoot);
    }

    rl.close();
    await finalizeBranch(currentBranch, squashBranch, backupBranch, prNumber, mergeDir);
    await cleanTmp();
}

if (require.main === module) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
