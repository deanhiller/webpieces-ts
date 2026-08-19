import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    BuildGateLog, BuildLogHeartbeat, BUILD_STAGE, FINISH_STAGE, REVIEW_STAGE, HEARTBEAT_MS, FAILURE_TAIL_LINES,
} from './build-gate-log';

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
     * `wp-build`'s log is the ONE path a person or an agent types from memory — `grep -n error
     * .webpieces/build.log` — so it is fixed, and history comes from the `.bak` rotation instead of from
     * the filename.
     */
    it('gives wp-build the fixed .webpieces/build.log, with no branch or sha in it', () => {
        const dir = repo('dean/my-feature');
        expect(new BuildGateLog().pathFor(dir, BUILD_STAGE)).toBe(path.join(dir, '.webpieces', 'build.log'));
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

    it('creates the log directory so the redirect can open the file', () => {
        const dir = repo('dean/x');
        expect(fs.existsSync(path.dirname(new BuildGateLog().pathFor(dir, REVIEW_STAGE)))).toBe(true);
    });

    it('existingLogFor is empty until a log is actually written, then names it', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        expect(log.existingLogFor(dir, BUILD_STAGE)).toBe('');
        const p = log.pathFor(dir, BUILD_STAGE);
        fs.writeFileSync(p, 'output\n');
        expect(log.existingLogFor(dir, BUILD_STAGE)).toBe(p);
    });

    it('backs a log up beside itself, as <log>.bak', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        expect(log.backupPathFor(log.pathFor(dir, BUILD_STAGE))).toBe(path.join(dir, '.webpieces', 'build.log.bak'));
    });
});

/** Rotation is what keeps the LAST TWO runs on disk, which is the whole reason the filename can be fixed. */
describe('BuildGateLog rotation', () => {
    it('moves an existing log to .bak before the next run writes', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        fs.writeFileSync(p, 'first-run\n');
        log.rotate(p);
        expect(fs.existsSync(p)).toBe(false);
        expect(fs.readFileSync(log.backupPathFor(p), 'utf8')).toContain('first-run');
    });

    it('overwrites an existing .bak rather than failing on it', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        fs.writeFileSync(log.backupPathFor(p), 'ancient\n');
        fs.writeFileSync(p, 'previous\n');
        log.rotate(p);
        expect(fs.readFileSync(log.backupPathFor(p), 'utf8')).toContain('previous');
    });

    // The first build in a fresh clone has nothing to rotate, and that is not a failure.
    it('is a no-op when there is no previous log', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        log.rotate(p);
        expect(fs.existsSync(log.backupPathFor(p))).toBe(false);
    });

    it('run() leaves the previous build readable as .bak', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        await log.run(dir, 'echo first-run', p);
        await log.run(dir, 'echo second-run', p);
        expect(fs.readFileSync(p, 'utf8')).toContain('second-run');
        expect(fs.readFileSync(p, 'utf8')).not.toContain('first-run');
        expect(fs.readFileSync(log.backupPathFor(p), 'utf8')).toContain('first-run');
    });
});

describe('BuildGateLog capture', () => {
    it('captures stdout AND stderr in full, and returns 0 on success', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        const code = await log.run(dir, 'echo out-line; echo err-line 1>&2', p);
        expect(code).toBe(0);
        const body = fs.readFileSync(p, 'utf8');
        expect(body).toContain('out-line');
        expect(body).toContain('err-line');
    });

    /**
     * A wrapper that swallows the build's exit code is worse than the problem it solves: every red build
     * would report green. The earlier `cmd | tee log` shape had exactly that defect — the shell reports
     * TEE's status — which is why nothing here is a pipeline.
     */
    it('returns the BUILD exit code', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        expect(await log.run(dir, 'echo boom 1>&2; exit 7', p)).toBe(7);
        expect(fs.readFileSync(p, 'utf8')).toContain('boom');
    });

    it('fails CLOSED when the command cannot start, and says so in the log', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        // A command the shell cannot find exits non-zero rather than never starting; either way, not 0.
        expect(await log.run(dir, 'no-such-binary-anywhere', p)).not.toBe(0);
    });

    // Nothing may be dropped: the whole promise is "the failures ARE in that file".
    it('does not truncate large output', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        await log.run(dir, "awk 'BEGIN{for(i=0;i<5000;i++) print \"line-\" i}'", p);
        const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
        expect(lines.length).toBe(5000);
        expect(lines[4999]).toBe('line-4999');
    });

    it('runs the build command verbatim, including a trailing shell comment', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        expect(await log.run(dir, 'echo kept # a trailing comment', p)).toBe(0);
        expect(fs.readFileSync(p, 'utf8')).toContain('kept');
    });

    it('leaves no side files beside the log', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        await log.run(dir, 'exit 3', p);
        expect(fs.existsSync(`${p}.status`)).toBe(false);
    });
});

/**
 * The heartbeat is the ONLY thing on the console while the build runs, so its two properties are load
 * bearing: the count must grow with the log, and a count that has NOT moved must say `still` — otherwise a
 * repeated number cannot be told from a stuck reporter.
 */
describe('BuildLogHeartbeat', () => {
    it('reports the growing line count', () => {
        const dir = repo('dean/x');
        const p = path.join(dir, 'build.log');
        const beat = new BuildLogHeartbeat(p, '.webpieces/build.log');
        fs.writeFileSync(p, 'a\nb\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 2 lines');
        fs.appendFileSync(p, 'c\nd\ne\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 5 lines');
    });

    it('appends `still` when the count has not changed since the previous tick', () => {
        const dir = repo('dean/x');
        const p = path.join(dir, 'build.log');
        const beat = new BuildLogHeartbeat(p, '.webpieces/build.log');
        fs.writeFileSync(p, 'a\nb\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 2 lines');
        expect(beat.tick()).toBe('.webpieces/build.log size 2 lines still');
        fs.appendFileSync(p, 'c\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 3 lines');
    });

    // The FIRST tick can never say `still`: there is nothing it has not changed since.
    it('never says still on the first tick, even at zero lines', () => {
        const dir = repo('dean/x');
        const beat = new BuildLogHeartbeat(path.join(dir, 'missing.log'), '.webpieces/build.log');
        expect(beat.tick()).toBe('.webpieces/build.log size 0 lines');
        expect(beat.tick()).toBe('.webpieces/build.log size 0 lines still');
    });

    it('ticks every 10 seconds', () => {
        expect(HEARTBEAT_MS).toBe(10_000);
    });
});

describe('BuildGateLog messages', () => {
    /**
     * SIZE is the feature. These messages replace "re-run the build yourself", so if the pointer ever
     * grows into a transcript it has defeated its own purpose. The tail is bounded for the same reason.
     */
    it('names the log and the backup on success, in three lines', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        await log.run(dir, 'echo first-run', p);
        await log.run(dir, 'echo second-run', p);
        const msg = log.successMessage(p);
        expect(msg).toContain('Build success');
        expect(msg).toContain(`FullLog : ${p}`);
        expect(msg).toContain('(build.log is backed up to build.log.bak every run so you have the last 2 builds of logs)');
        expect(msg.trim().split('\n').length).toBe(3);
    });

    // The FIRST build in a tree has no .bak, and a pointer at a file that does not exist is a wasted read.
    it('does not claim a backup that does not exist yet', async () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        await log.run(dir, 'echo only-run', p);
        const msg = log.successMessage(p);
        expect(msg).toContain('this is the first, so there is none yet');
        expect(msg).not.toContain('is backed up to build.log.bak every run');
    });

    it('on failure names the command, the log, and echoes a bounded tail', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        fs.writeFileSync(p, Array.from({ length: 200 }, (_v: unknown, i: number): string => `line-${i}`).join('\n') + '\n');
        const msg = log.failureMessage('pnpm nx affected --target=ci', p);
        expect(msg).toContain('Build Failed: pnpm nx affected --target=ci');
        expect(msg).toContain(`FullLog : ${p}`);
        expect(msg).toContain('line-199');
        expect(msg).not.toContain('line-0\n');
        expect(msg.split('\n').filter((l: string): boolean => l.startsWith('    line-')).length).toBe(FAILURE_TAIL_LINES);
    });

    /**
     * This renders the message for a build that has ALREADY failed. If reading the log threw, the caller
     * would be handed a filesystem error INSTEAD of the build failure — the one outcome that loses the
     * thing they were told to read.
     */
    it('reports an unreadable log rather than throwing over it', () => {
        const dir = repo('dean/x');
        const log = new BuildGateLog();
        const p = log.pathFor(dir, BUILD_STAGE);
        fs.mkdirSync(p);  // exists, but readFileSync cannot read a directory
        const msg = log.failureMessage('pnpm build', p);
        expect(msg).toContain(`could not read ${p}`);
        expect(msg).toContain(`FullLog : ${p}`);
    });

    it('says so rather than showing an empty tail when there is no log to read', () => {
        expect(new BuildGateLog().failureMessage('pnpm build', '/abs/nope.log')).toContain('(no log file at /abs/nope.log)');
    });

    // It must NOT teach the thing it exists to prevent.
    it('never tells the AI to re-run the build to see the errors', () => {
        const msg = new BuildGateLog().failureMessage('pnpm build', '/abs/b.log');
        expect(msg).not.toContain('Run THIS exact command to reproduce');
        expect(msg).toContain('Do NOT re-run the build to see them.');
    });
});
