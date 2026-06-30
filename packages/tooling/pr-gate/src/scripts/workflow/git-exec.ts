import { spawnSync } from 'child_process';

/**
 * Run a git command that is expected to succeed; abort the process with a clear message
 * if it fails. Used for fetch/pull/checkout/commit where silently continuing on failure
 * would operate on stale or wrong state.
 */
export function runGitChecked(args: string[], errMsg: string): void {
    const result = spawnSync('git', args, { stdio: 'inherit' });
    if (result.status !== 0) {
        process.stderr.write(`❌ ${errMsg} (git ${args.join(' ')} exited ${String(result.status)})\n`);
        process.exit(1);
    }
}

/**
 * Push HEAD to origin/<currentBranch>. Single source of truth shared by wp-start-upsert-pr and
 * wp-finish-upsert-pr (they pushed with identical copy-pasted logic). Uses --force-with-lease for an
 * existing remote branch (the 3-point squash rewrites history) and -u for a brand-new branch.
 */
export function ensurePushed(currentBranch: string): void {
    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch]).status === 0;
    if (remoteExists) {
        runGitChecked(['push', '--force-with-lease', 'origin', `HEAD:${currentBranch}`], 'Failed to push branch');
    } else {
        runGitChecked(['push', '-u', 'origin', `HEAD:${currentBranch}`], 'Failed to push new branch');
    }
}
