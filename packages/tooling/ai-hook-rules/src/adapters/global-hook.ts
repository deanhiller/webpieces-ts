import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

interface SkipHooksFile {
    expires: number | null;
    reason?: string;
}

interface HookPayload {
    tool_name?: string;
    tool_input?: {
        file_path?: string;
    };
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

    let payload: HookPayload | null = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        if (rawInput.trim()) {
            payload = JSON.parse(rawInput) as HookPayload;
        }
    } catch (err: unknown) {
        //const error = toError(err); -- malformed stdin is intentionally ignored; must not crash global hook
    }

    // 1. Check .skiphooks — if valid and not expired, allow everything
    const skipHooks = readSkipHooks(cwd);
    if (skipHooks !== null) {
        const nowSeconds = Date.now() / 1000;
        if (skipHooks.expires === null || nowSeconds < skipHooks.expires) {
            process.exit(0);
        }
    }

    // 2. Always allow writing .webpieces/skiphooks (this is the escape hatch)
    const filePath = payload?.tool_input?.file_path ?? '';
    if (payload?.tool_name === 'Write' && filePath.endsWith('.webpieces/skiphooks')) {
        process.exit(0);
    }

    // 3. Delegate to per-repo hook if present
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

    // 4. No local hook found — block and instruct AI
    process.stdout.write(
        'This project is missing the webpieces AI hook (./node_modules/.bin/wp-ai-hook not found).\n' +
            'Ask the human one of:\n' +
            '  A) Install webpieces: run `npm install @webpieces/ai-hook-rules` then retry\n' +
            '  B) Skip hooks: ask how long (1 hour / 1 day / forever), then write .webpieces/skiphooks:\n' +
            '       {"expires": <unix epoch seconds>, "reason": "..."}\n' +
            '     or for forever: {"expires": null, "reason": "..."}\n' +
            '  Note: writing .webpieces/skiphooks is ALWAYS allowed even while blocked.\n',
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
