import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildGateLog, FINISH_STAGE, REVIEW_STAGE } from './build-gate-log';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real git repo — the log path is derived from git's own branch/sha, so a fake directory proves nothing. */
function repo(branch: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-buildlog-')));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    git(dir, 'config', 'user.email', 'spec@example.com');
    git(dir, 'config', 'user.name', 'spec');
    fs.writeFileSync(path.join(dir, 'README.md'), '# spec\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    if (branch !== 'main') git(dir, 'checkout', '-q', '-b', branch);
    return dir;
}

describe('BuildGateLog paths', () => {
    it('names the log for the stage, the branch and the short sha, under .webpieces/logs', () => {
        const dir = repo('dean/my-feature');
        const log = new BuildGateLog().pathFor(dir, REVIEW_STAGE);
        expect(log.startsWith(path.join(dir, '.webpieces', 'logs') + path.sep)).toBe(true);
        expect(path.basename(log)).toBe(`build-gate-review-dean-my-feature-${git(dir, 'rev-parse', '--short', 'HEAD')}.log`);
    });

    /**
     * The two gates that can both run against ONE commit must not write one file — otherwise finish's log
     * would overwrite the review log a failure message may still be pointing at.
     */
    it('gives review and finish different files at the same commit', () => {
        const dir = repo('dean/my-feature');
        expect(new BuildGateLog().pathFor(dir, REVIEW_STAGE))
            .not.toBe(new BuildGateLog().pathFor(dir, FINISH_STAGE));
    });

    // A `/` in a branch name must never become a directory separator in the log filename.
    it('flattens slashes in the branch rather than creating directories', () => {
        const dir = repo('dean/deep/nested');
        expect(path.basename(new BuildGateLog().pathFor(dir, REVIEW_STAGE))).toContain('dean-deep-nested');
    });

    it('creates the log directory so tee can open the file', () => {
        const dir = repo('dean/x');
        expect(fs.existsSync(path.dirname(new BuildGateLog().pathFor(dir, REVIEW_STAGE)))).toBe(true);
    });

    it('existingLogFor is empty until a log is actually written, then names it', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        expect(log.existingLogFor(dir, REVIEW_STAGE)).toBe('');
        const p = log.pathFor(dir, REVIEW_STAGE);
        fs.writeFileSync(p, 'output\n');
        expect(log.existingLogFor(dir, REVIEW_STAGE)).toBe(p);
    });
});

describe('BuildGateLog capture', () => {
    it('captures stdout AND stderr in full, and returns 0 on success', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, REVIEW_STAGE);
        const code = log.run(dir, 'echo out-line; echo err-line 1>&2', p);
        expect(code).toBe(0);
        const body = fs.readFileSync(p, 'utf8');
        expect(body).toContain('out-line');
        expect(body).toContain('err-line');
    });

    /**
     * THE bug this design exists to avoid: in `cmd | tee log` the shell reports TEE's status, which is 0
     * whether the build passed or failed. If this ever regresses, every red build reports green.
     */
    it('returns the BUILD exit code, not tee\'s', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, REVIEW_STAGE);
        expect(log.run(dir, 'echo boom 1>&2; exit 7', p)).toBe(7);
        expect(fs.readFileSync(p, 'utf8')).toContain('boom');
    });

    it('leaves no .status side file behind', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, REVIEW_STAGE);
        log.run(dir, 'exit 3', p);
        expect(fs.existsSync(`${p}.status`)).toBe(false);
        expect(fs.readFileSync(p, 'utf8')).not.toContain('3');
    });

    // Nothing may be dropped: the whole promise is "the failures ARE in that file".
    it('does not truncate large output', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, REVIEW_STAGE);
        log.run(dir, "awk 'BEGIN{for(i=0;i<5000;i++) print \"line-\" i}'", p);
        const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
        expect(lines.length).toBe(5000);
        expect(lines[4999]).toBe('line-4999');
    });

    it('runs the build command verbatim, including a trailing shell comment', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, REVIEW_STAGE);
        expect(log.run(dir, 'echo kept # a trailing comment', p)).toBe(0);
        expect(fs.readFileSync(p, 'utf8')).toContain('kept');
    });

    // A second run at the same commit is the same build of the same tree; the fresh one is what to read.
    it('truncates a previous run at the same commit rather than appending', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, REVIEW_STAGE);
        log.run(dir, 'echo first-run', p);
        log.run(dir, 'echo second-run', p);
        const body = fs.readFileSync(p, 'utf8');
        expect(body).toContain('second-run');
        expect(body).not.toContain('first-run');
    });
});

describe('BuildGateLog.failureMessage', () => {
    /**
     * SIZE is the feature. This message replaces "re-run the build yourself", so if it ever grows into a
     * transcript it has defeated its own purpose.
     */
    it('is tiny, names the command and the absolute log path, and forbids guessing', () => {
        const msg = new BuildGateLog().failureMessage('pnpm nx affected --target=ci', '/abs/.webpieces/logs/b.log');
        expect(msg).toContain('The CI build failed');
        expect(msg).toContain('pnpm nx affected --target=ci > /abs/.webpieces/logs/b.log');
        expect(msg).toContain('read that file for the failures');
        expect(msg).toContain('If you do not see failures in that log, report that to the user and stop.');
        expect(msg.trim().split('\n').filter((l: string): boolean => l.trim() !== '').length).toBeLessThanOrEqual(5);
    });

    // It must NOT teach the thing it exists to prevent.
    it('never tells the AI to re-run the build to see the errors', () => {
        const msg = new BuildGateLog().failureMessage('pnpm build', '/abs/b.log');
        expect(msg).not.toContain('Run THIS exact command to reproduce');
    });
});
