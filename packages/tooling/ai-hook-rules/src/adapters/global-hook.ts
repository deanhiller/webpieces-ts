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
    process.stderr.write(
        'STOP. You MUST ask the human to run one of 3 commands to continue.\n' +
            '\n' +
            'This project is missing the webpieces AI hook (./node_modules/.bin/wp-ai-hook not found).\n' +
            '\n' +
            'Present these THREE options to the human verbatim and wait for them to pick one.\n' +
            'Each option is a command the human can copy-paste into their own terminal:\n' +
            '\n' +
            '  A) PREFERRED — install the hook.\n' +
            '     If this is a pnpm workspace, run from the monorepo root:\n' +
            '         pnpm add -Dw @webpieces/ai-hook-rules\n' +
            '     Otherwise, run from the project root:\n' +
            '         npm install --save-dev @webpieces/ai-hook-rules\n' +
            '\n' +
            '  B) Skip hooks temporarily (auto-expires). Ask the human how long, then have them run\n' +
            '     ONE of these from the project root:\n' +
            '       1 hour:  mkdir -p .webpieces && printf \'{"expires": %s, "reason": "temporary skip"}\' "$(($(date +%s) + 3600))" > .webpieces/skiphooks\n' +
            '       1 week:  mkdir -p .webpieces && printf \'{"expires": %s, "reason": "temporary skip"}\' "$(($(date +%s) + 604800))" > .webpieces/skiphooks\n' +
            '\n' +
            '  C) Disable permanently (NEVER expires — hooks stay off until this file is deleted).\n' +
            '     Only choose this if the human explicitly wants it. Have them run from the project root:\n' +
            '         mkdir -p .webpieces && printf \'{"expires": null, "reason": "permanently disabled"}\' > .webpieces/skiphooks\n' +
            '     To re-enable later: rm .webpieces/skiphooks\n' +
            '\n' +
            'You are BLOCKED. Ask the human now and wait for their response.\n',
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
