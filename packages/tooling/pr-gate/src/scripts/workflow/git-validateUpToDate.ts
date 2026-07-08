import { execSync, spawnSync } from 'child_process';
import { CliExitError, runMain } from '@webpieces/rules-config';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

export async function main(): Promise<void> {
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();

    if (branch === 'main') {
        process.stdout.write('✅ On main branch - no validation needed\n');
        return;
    }

    process.stdout.write('Validating branch is up to date with origin/main...\n');
    process.stdout.write(`Current branch: ${branch}\n`);
    process.stdout.write('\n');

    process.stdout.write('Fetching latest from origin/main...\n');
    spawnSync('git', ['fetch', 'origin', 'main', '--quiet'], { stdio: 'inherit' });

    const isUpToDate = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).status === 0;

    if (isUpToDate) {
        process.stdout.write('✅ Branch is up to date with origin/main\n');
        return;
    }

    const behindResult = spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8' });
    const commitsBehind = (behindResult.stdout ?? '').trim();

    const recentResult = spawnSync('git', ['log', '--oneline', 'HEAD..origin/main'], { encoding: 'utf8' });
    const recentLines = (recentResult.stdout ?? '').split('\n').filter((l: string) => l).slice(0, 5).join('\n');

    process.stdout.write('\n');
    process.stdout.write(SEP);
    process.stdout.write('❌ ERROR: Branch is NOT up to date with origin/main\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');
    process.stdout.write(`Your branch is ${commitsBehind} commit(s) behind origin/main\n`);
    process.stdout.write('\n');
    process.stdout.write('Recent commits in origin/main not in your branch:\n');
    process.stdout.write(recentLines + '\n');
    process.stdout.write('\n');
    process.stdout.write(SEP);
    process.stdout.write('⚠️  CRITICAL: You must update your branch first!\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');
    process.stdout.write('1. Update your branch with latest main:\n');
    process.stdout.write('   pnpm wp-start-update\n');
    process.stdout.write('\n');
    process.stdout.write('2. ⚠️  IMPORTANT: REVIEW THE CODE AFTER MERGE!\n');
    process.stdout.write('   - Check for merge conflicts\n');
    process.stdout.write('   - Review how your changes interact with new main code\n');
    process.stdout.write('   - Test that everything still works\n');
    process.stdout.write('   - This is where things often go wrong!\n');
    process.stdout.write('\n');
    process.stdout.write('3. After reviewing, run your command again\n');
    process.stdout.write('\n');
    process.stdout.write(SEP);
    process.stdout.write('Why this matters:\n');
    process.stdout.write(SEP);
    process.stdout.write('\n');
    process.stdout.write('- Your test plan should cover how your changes work with\n');
    process.stdout.write('  the LATEST code from main, not outdated code\n');
    process.stdout.write('- Merging main might introduce conflicts or integration\n');
    process.stdout.write('  issues that need testing\n');
    process.stdout.write('- Your changes might interact unexpectedly with new code\n');
    process.stdout.write('  from main\n');
    process.stdout.write('\n');
    process.stdout.write(SEP);

    // The full guidance was already printed to stdout above; throw with an empty message so runMain
    // exits 1 without echoing a redundant line.
    throw new CliExitError(1, '');
}

if (require.main === module) runMain(main);
