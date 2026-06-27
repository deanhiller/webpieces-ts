#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

export async function main(): Promise<void> {
    process.stdout.write(SEP);
    process.stdout.write('📝 Staging Merge Changes for Review\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');

    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();

    const originMainResult = spawnSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' });
    const mainFallbackResult = spawnSync('git', ['rev-parse', 'main'], { encoding: 'utf8' });
    const newForkPoint = (
        originMainResult.status === 0
            ? (originMainResult.stdout ?? '')
            : (mainFallbackResult.stdout ?? '')
    ).trim();

    const inMergeState = spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD']).status === 0;

    let oldForkPoint: string;
    if (inMergeState) {
        const mergeHead = execSync('git rev-parse MERGE_HEAD', { encoding: 'utf8' }).trim();
        const result = spawnSync('git', ['merge-base', mergeHead, 'origin/main'], { encoding: 'utf8' });
        oldForkPoint = (result.stdout ?? '').trim();
    } else {
        const result = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' });
        oldForkPoint = (result.stdout ?? '').trim();
    }

    process.stdout.write(`Branch: ${currentBranch}\n`);
    process.stdout.write(`Old fork point: ${oldForkPoint.slice(0, 12)}\n`);
    process.stdout.write(`New fork point: ${newForkPoint.slice(0, 12)}\n`);
    process.stdout.write('\n');

    process.stdout.write('Staging all resolved changes...\n');
    spawnSync('git', ['add', '-A'], { stdio: 'inherit' });

    process.stdout.write('\n');
    process.stdout.write(SEP);
    process.stdout.write('✅ All changes staged for review\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');
    process.stdout.write('📋 Review staged changes with:\n');
    process.stdout.write('   git diff --cached\n');
    process.stdout.write('\n');
    process.stdout.write('📋 View list of changed files:\n');
    process.stdout.write('   git status\n');
    process.stdout.write('\n');
    process.stdout.write('⚠️  REVIEW CAREFULLY before committing!\n');
    process.stdout.write('\n');
    process.stdout.write('When ready to commit, the git-updateFromMain.sh script will continue.\n');
    process.stdout.write('\n');
}

if (require.main === module) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
