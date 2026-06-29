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
