import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitProcessClient, NativeProcessClient, PROCESS_KILLED, PROCESS_NOT_STARTED } from '@webpieces/tooling-common';

import { specTempDirs } from '../spec-temp-dirs';

/**
 * The FEW real-process tests (#1381). Every feature test in the tooling rebinds these edges to mocks;
 * this is the one place that proves the production clients really start the program, report its exit
 * code, capture its output whole, and never throw for a program that could not be started.
 *
 * They sit here, beside the MOCKS of the same edges, rather than in `@webpieces/tooling-common` beside
 * the clients: a scratch directory must come from `specTempDirs` (so it is reaped), which lives in this
 * package, and tooling-common may not depend on its own testkit.
 */

const dirs: string[] = [];

function scratch(): string {
    const dir = specTempDirs.make('wp-process-clients-');
    dirs.push(dir);
    return dir;
}

afterEach((): void => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GitProcessClient', () => {
    it('reports git\'s exit code and output, and a refusal as a non-zero result rather than a throw', async () => {
        const dir = scratch();
        const git = new GitProcessClient();

        expect((await git.run(['init', '-q', '-b', 'main'], dir)).code).toBe(0);
        const inside = await git.run(['rev-parse', '--is-inside-work-tree'], dir);
        expect(inside.ok).toBe(true);
        expect(inside.stdout.trim()).toBe('true');

        const missing = await git.run(['rev-parse', '--verify', 'no-such-ref'], dir);
        expect(missing.code).toBe(128);
        expect(missing.stderr).toContain('Needed a single revision');
    });

    it('reports a git that could not be started (a cwd that does not exist) as PROCESS_NOT_STARTED', async () => {
        const result = await new GitProcessClient().run(['status'], path.join(scratch(), 'gone'));
        expect(result.code).toBe(PROCESS_NOT_STARTED);
        expect(result.stderr).toContain('ENOENT');
    });

    // The guard's blocking path: same contract, synchronously.
    it('runSync reports git\'s exit code and output without a promise, and a missing cwd as not started', () => {
        const dir = scratch();
        const git = new GitProcessClient();
        expect(git.runSync(['init', '-q', '-b', 'main'], dir, 30_000).code).toBe(0);
        expect(git.runSync(['rev-parse', '--is-inside-work-tree'], dir, 30_000).stdout.trim()).toBe('true');
        expect(git.runSync(['rev-parse', '--verify', 'no-such-ref'], dir, 30_000).code).toBe(128);
        expect(git.runSync(['status'], path.join(dir, 'gone'), 30_000).code).toBe(PROCESS_NOT_STARTED);
    });
});

describe('a deadline kills the run', () => {
    // What CommandTimeouts relies on: aborting the signal kills the child and the run resolves KILLED.
    it('reports a run whose signal aborted as PROCESS_KILLED, never as a hang or a throw', async () => {
        const abort = new AbortController();
        const running = new NativeProcessClient().run(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'],
            undefined, abort.signal);
        abort.abort();
        const result = await running;
        expect(result.code).toBe(PROCESS_KILLED);
        expect(result.ok).toBe(false);
    });
});

describe('NativeProcessClient', () => {
    it('captures stdout and stderr separately and returns the exit code', async () => {
        const result = await new NativeProcessClient().run(process.execPath,
            ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
        expect(result.code).toBe(3);
        expect(result.stdout).toBe('out');
        expect(result.stderr).toBe('err');
    });

    it('never throws for a program that is not on PATH', async () => {
        const result = await new NativeProcessClient().run('no-such-program-anywhere-1381', []);
        expect(result.code).toBe(PROCESS_NOT_STARTED);
        expect(result.ok).toBe(false);
    });

    it('a pass-through run returns the exit code and captures nothing', async () => {
        const result = await new NativeProcessClient().passThrough(process.execPath, ['-e', 'process.exit(5)']);
        expect(result.code).toBe(5);
        expect(result.stdout).toBe('');
    });

    it('runShellToFile sends stdout AND stderr to the file, whole, and returns the exit code', async () => {
        const dir = scratch();
        const file = path.join(dir, 'build.log');
        const fd = fs.openSync(file, 'w');
        const ended = await new NativeProcessClient().runShellToFile(
            'echo out-line; echo err-line 1>&2; awk \'BEGIN{for(i=0;i<5000;i++) print "line-" i}\'; exit 7 # a trailing comment',
            dir, fd);
        fs.closeSync(fd);

        expect(ended.code).toBe(7);
        expect(ended.signal).toBeNull();
        const body = fs.readFileSync(file, 'utf8');
        expect(body).toContain('out-line');
        expect(body).toContain('err-line');
        expect(body.trim().split('\n')).toHaveLength(5002);
        expect(body).toContain('line-4999');
    });

    it('runShellToFile reports a command killed by a signal', async () => {
        const dir = scratch();
        const fd = fs.openSync(path.join(dir, 'build.log'), 'w');
        const ended = await new NativeProcessClient().runShellToFile('kill -TERM $$', dir, fd);
        fs.closeSync(fd);
        expect(ended.code).toBeNull();
        expect(ended.signal).toBe('SIGTERM');
    });

    it('runShellToFile reports a command that could not be started instead of throwing', async () => {
        const dir = scratch();
        const fd = fs.openSync(path.join(dir, 'build.log'), 'w');
        const ended = await new NativeProcessClient().runShellToFile('echo never', path.join(dir, 'gone'), fd);
        fs.closeSync(fd);
        expect(ended.startError).toContain('ENOENT');
    });
});
