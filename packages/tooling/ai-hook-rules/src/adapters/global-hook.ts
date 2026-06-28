import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

interface SkipHooksFile {
    expires: number | null;
    reason?: string;
}

function readSkipHooks(cwd: string): SkipHooksFile | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const skipPath = join(cwd, '.webpieces', 'skiphooks');
        if (!existsSync(skipPath)) return null;
        return JSON.parse(readFileSync(skipPath, 'utf8')) as SkipHooksFile;
    } catch (err: unknown) {
        // eslint-disable-next-line @webpieces/catch-error-pattern -- intentionally discard; malformed .skiphooks must not crash global hook
        return null;
    }
}

function run(rawInput: string): void {
    const cwd = process.cwd();

    // 1. Check .skiphooks — if valid and not expired, allow everything
    const skipHooks = readSkipHooks(cwd);
    if (skipHooks !== null) {
        const nowSeconds = Date.now() / 1000;
        if (skipHooks.expires === null || nowSeconds < skipHooks.expires) {
            process.exit(0);
        }
    }

    // 2. Delegate to per-repo hook if present
    const localHook = join(cwd, 'node_modules', '.bin', 'wp-ai-hook');
    if (existsSync(localHook)) {
        const result = spawnSync(localHook, [], {
            input: Buffer.from(rawInput),
            encoding: 'buffer',
        });
        if (result.stdout?.length) process.stdout.write(result.stdout);
        if (result.stderr?.length) process.stderr.write(result.stderr);
        process.exit(result.status ?? 0);
    }

    // 3. No local hook found — block and tell AI to present human-only options
    const skipPath = join(cwd, '.webpieces', 'skiphooks');
    process.stderr.write(
        'STOP. DO NOT TAKE ANY ACTION. You MUST present these options to the human and wait.\n' +
            '\n' +
            `Hook cwd: ${cwd}\n` +
            `Expected binary: ${localHook} (not found)\n` +
            '\n' +
            'Tell the human to run ONE of:\n' +
            '  A) Install the hook (preferred):\n' +
            '       npm install @webpieces/ai-hook-rules\n' +
            '  B) Skip hooks for 1 hour (human runs in terminal):\n' +
            `       echo \'{"expires":\'$(( $(date +%s) + 3600 ))\', "reason":"<why>"}\' > ${skipPath}\n` +
            '  C) Skip hooks indefinitely (requires explicit human approval):\n' +
            `       echo \'{"expires":null, "reason":"<why>"}\' > ${skipPath}\n` +
            '\n' +
            'You are BLOCKED until the human runs one of the above commands.\n',
    );
    process.exit(2);
}

let stdinData = '';
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
    stdinData += chunk;
});
process.stdin.on('end', () => {
    run(stdinData);
});
