import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BuildTermination } from '@webpieces/rules-config';
import {
    BuildGateLog,
    BuildLogHeartbeat,
    BUILD_STAGE,
    FINISH_STAGE,
    REVIEW_STAGE,
    HEARTBEAT_MS,
    FAILURE_TAIL_LINES,
} from './build-gate-log';
import { GateLogFile } from './gate-log-file';
import { StageOutputLog } from './stage-output-log';
import { ScriptedShellRun } from '@webpieces/tooling-testkit';
import { PrGateFeature } from '../../__tests__/feature-harness';

/**
 * The production BuildGateLog from the shipped container, over real collaborators — `GateLogFile` owns
 * WHERE the log goes and how it rotates (its own spec covers that); `StageOutputLog` is the console broker
 * the heartbeat writes through — with its two process edges SCRIPTED (#1381): git (the short sha in the
 * log name) and the build command itself, whose output the mock writes into the log file exactly as the
 * real command's redirect would. That the real shell redirect captures stdout and stderr whole, reports
 * exit codes and signals, is proven once, in `@webpieces/tooling-common`'s process-clients spec.
 */
const SHORT_SHA = 'abc1234';
let feature: PrGateFeature;

beforeEach(async () => {
    feature = await PrGateFeature.create();
});

function newLog(): BuildGateLog {
    return feature.container.get(BuildGateLog);
}

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A checkout on `branch` at SHORT_SHA. The branch is read from `.git/HEAD` on disk (GitCheckout, zero
 * processes); the short sha is git's answer, scripted.
 */
function repo(branch: string): string {
    const dir = specTempDirs.makeReal('wp-buildlog-');
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    feature.git.respond(['-C', dir, 'rev-parse', '--short', 'HEAD'], feature.git.ok(`${SHORT_SHA}\n`));
    return dir;
}

/** The build command `command` prints `output` into the log and ends as `run` says. */
function build(command: string, run: ScriptedShellRun): void {
    feature.processes.respondToShell(command, run);
}

describe('BuildGateLog paths', () => {
    it('names the log for the stage, the branch and the short sha, under .webpieces/logs', async () => {
        const dir = repo('dean/my-feature');
        const log = (await newLog().pathFor(dir, REVIEW_STAGE));
        expect(log.startsWith(path.join(dir, '.webpieces', 'logs') + path.sep)).toBe(true);
        expect(path.basename(log)).toBe(`build-gate-review-dean-my-feature-${SHORT_SHA}.log`);
    });

    /**
     * `wp-build`'s log is the ONE path a person or an agent types from memory — `grep -n error
     * .webpieces/build.log` — so it is fixed, and history comes from the `.bak` rotation instead of from
     * the filename.
     */
    it('gives wp-build the fixed .webpieces/build.log, with no branch or sha in it', async () => {
        const dir = repo('dean/my-feature');
        expect((await newLog().pathFor(dir, BUILD_STAGE))).toBe(path.join(dir, '.webpieces', 'build.log'));
    });

    /**
     * The two gates that can both run against ONE commit must not write one file — otherwise finish's log
     * would overwrite the review log a failure message may still be pointing at.
     */
    it('gives review and finish different files at the same commit', async () => {
        const dir = repo('dean/my-feature');
        expect((await newLog().pathFor(dir, REVIEW_STAGE))).not.toBe((await newLog().pathFor(dir, FINISH_STAGE)));
    });

    // A `/` in a branch name must never become a directory separator in the log filename.
    it('flattens slashes in the branch rather than creating directories', async () => {
        const dir = repo('dean/deep/nested');
        expect(path.basename((await newLog().pathFor(dir, REVIEW_STAGE)))).toContain('dean-deep-nested');
    });

    it('creates the log directory so the redirect can open the file', async () => {
        const dir = repo('dean/x');
        expect(fs.existsSync(path.dirname((await newLog().pathFor(dir, REVIEW_STAGE))))).toBe(true);
    });

    it('existingLogFor is empty until a log is actually written, then names it', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        expect(await log.existingLogFor(dir, BUILD_STAGE)).toBe('');
        const p = await log.pathFor(dir, BUILD_STAGE);
        fs.writeFileSync(p, 'output\n');
        expect(await log.existingLogFor(dir, BUILD_STAGE)).toBe(p);
    });
});

/**
 * Rotation itself is GateLogFile's (see its spec). What belongs HERE is that `run()` actually rotates
 * before it writes — the guarantee that makes a fixed filename safe.
 */
describe('BuildGateLog rotation', () => {
    it('run() leaves the previous build readable as .bak', async () => {
        const dir = repo('dean/x');
        const files = feature.container.get(GateLogFile);
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(0, 'first-run\n'));
        build('pnpm build', feature.processes.exited(0, 'second-run\n'));
        await log.run(dir, 'pnpm build', p);
        await log.run(dir, 'pnpm build', p);
        expect(fs.readFileSync(p, 'utf8')).toContain('second-run');
        expect(fs.readFileSync(p, 'utf8')).not.toContain('first-run');
        expect(fs.readFileSync(files.backupPathFor(p), 'utf8')).toContain('first-run');
    });
});

describe('BuildGateLog capture', () => {
    it('can follow build.log live while preserving the complete file', async () => {
        const dir = repo('dean/x');
        const files = new GateLogFile();
        const output: string[] = [];
        const console = new StageOutputLog(files);
        console.say = (text: string): void => {
            output.push(text);
        };
        (await feature.container.rebind(StageOutputLog)).toConstantValue(console);
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(0, 'first\nsecond\n'));
        await log.runStreaming(dir, 'pnpm build', p);
        expect(output.join('')).toContain('first');
        expect(output.join('')).toContain('second');
        expect(fs.readFileSync(p, 'utf8')).toBe('first\nsecond\n');
    });

    it('captures stdout AND stderr in full, and returns 0 on success', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(0, 'out-line\nerr-line\n'));
        const termination = await log.run(dir, 'pnpm build', p);
        expect(termination).toEqual(new BuildTermination(0, null));
        // ONE shell command, run in the repo, writing into the log — never a pipeline whose status lies.
        expect(feature.processes.shellCalls.map((c): string => `${c.cwd ?? ''}: ${c.args[0]}`)).toEqual([`${dir}: pnpm build`]);
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
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(7, 'boom\n'));
        expect(await log.run(dir, 'pnpm build', p)).toEqual(
            new BuildTermination(7, null),
        );
        expect(fs.readFileSync(p, 'utf8')).toContain('boom');
    });

    it('fails CLOSED when the command cannot start, and says so in the log', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        // A command that never starts fails CLOSED to 1 — a build that never ran is never green.
        build('pnpm build', feature.processes.notStarted('spawn /bin/sh ENOENT'));
        expect(await log.run(dir, 'pnpm build', p)).toEqual(new BuildTermination(1, null));
        expect(fs.readFileSync(p, 'utf8')).toContain('The build command could not be started: spawn /bin/sh ENOENT');
    });

    // Nothing may be dropped: the whole promise is "the failures ARE in that file".
    it('does not truncate large output', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        const many = Array.from({ length: 5000 }, (_v: unknown, i: number): string => `line-${i}`).join('\n') + '\n';
        build('pnpm build', feature.processes.exited(0, many));
        await log.run(dir, 'pnpm build', p);
        const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
        expect(lines.length).toBe(5000);
        expect(lines[4999]).toBe('line-4999');
    });

    it('runs the build command verbatim, including a trailing shell comment', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build # a trailing comment', feature.processes.exited(0, 'kept\n'));
        expect(await log.run(dir, 'pnpm build # a trailing comment', p)).toEqual(
            new BuildTermination(0, null),
        );
        expect(fs.readFileSync(p, 'utf8')).toContain('kept');
        expect(feature.processes.shellCalls[0].args).toEqual(['pnpm build # a trailing comment']);
    });

    it('records the signal in the FullLog when the build process is terminated', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.killed('SIGTERM'));
        const termination = await log.run(dir, 'pnpm build', p);
        expect(termination).toEqual(new BuildTermination(null, 'SIGTERM'));
        expect(fs.readFileSync(p, 'utf8')).toContain(
            'Build process termination: exit code null; signal SIGTERM.',
        );
    });

    it('leaves no side files beside the log', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(3));
        await log.run(dir, 'pnpm build', p);
        expect(fs.existsSync(`${p}.status`)).toBe(false);
    });
});

/**
 * The heartbeat is the ONLY thing on the console while the build runs, so its two properties are load
 * bearing: the count must grow with the log, and a count that has NOT moved must say `still` — otherwise a
 * repeated number cannot be told from a stuck reporter.
 */
describe('BuildLogHeartbeat', () => {
    it('reports the growing line count', async () => {
        const dir = repo('dean/x');
        const p = path.join(dir, 'build.log');
        const beat = new BuildLogHeartbeat(new GateLogFile(), p, '.webpieces/build.log');
        fs.writeFileSync(p, 'a\nb\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 2 lines');
        fs.appendFileSync(p, 'c\nd\ne\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 5 lines');
    });

    it('appends `still` when the count has not changed since the previous tick', async () => {
        const dir = repo('dean/x');
        const p = path.join(dir, 'build.log');
        const beat = new BuildLogHeartbeat(new GateLogFile(), p, '.webpieces/build.log');
        fs.writeFileSync(p, 'a\nb\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 2 lines');
        expect(beat.tick()).toBe('.webpieces/build.log size 2 lines still');
        fs.appendFileSync(p, 'c\n');
        expect(beat.tick()).toBe('.webpieces/build.log size 3 lines');
    });

    // The FIRST tick can never say `still`: there is nothing it has not changed since.
    it('never says still on the first tick, even at zero lines', async () => {
        const dir = repo('dean/x');
        const beat = new BuildLogHeartbeat(
            new GateLogFile(),
            path.join(dir, 'missing.log'),
            '.webpieces/build.log',
        );
        expect(beat.tick()).toBe('.webpieces/build.log size 0 lines');
        expect(beat.tick()).toBe('.webpieces/build.log size 0 lines still');
    });

    it('ticks every 10 seconds', async () => {
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
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(0, 'first-run\n'));
        build('pnpm build', feature.processes.exited(0, 'second-run\n'));
        await log.run(dir, 'pnpm build', p);
        await log.run(dir, 'pnpm build', p);
        const msg = log.successMessage(p);
        expect(msg).toContain('Build success');
        expect(msg).toContain(`FullLog : ${p}`);
        expect(msg).toContain(
            '(build.log is backed up to build.log.bak every run so you have the last 2 runs of logs)',
        );
        expect(msg.trim().split('\n').length).toBe(3);
    });

    // The FIRST build in a tree has no .bak, and a pointer at a file that does not exist is a wasted read.
    it('does not claim a backup that does not exist yet', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        build('pnpm build', feature.processes.exited(0, 'only-run\n'));
        await log.run(dir, 'pnpm build', p);
        const msg = log.successMessage(p);
        expect(msg).toContain('this is the first, so there is none yet');
        expect(msg).not.toContain('is backed up to build.log.bak every run');
    });

    it('on failure names the command, the log, and echoes a bounded tail', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        fs.writeFileSync(
            p,
            Array.from({ length: 200 }, (_v: unknown, i: number): string => `line-${i}`).join(
                '\n',
            ) + '\n',
        );
        const msg = log.failureMessage(
            'pnpm nx affected --target=ci',
            p,
            new BuildTermination(7, null),
        );
        expect(msg).toContain('Build Failed: pnpm nx affected --target=ci');
        expect(msg).toContain(`FullLog : ${p}`);
        expect(msg).toContain('line-199');
        expect(msg).not.toContain('line-0\n');
        expect(
            msg.split('\n').filter((l: string): boolean => l.startsWith('    line-')).length,
        ).toBe(FAILURE_TAIL_LINES);
    });

    /**
     * This renders the message for a build that has ALREADY failed. If reading the log threw, the caller
     * would be handed a filesystem error INSTEAD of the build failure — the one outcome that loses the
     * thing they were told to read.
     */
    it('reports an unreadable log rather than throwing over it', async () => {
        const dir = repo('dean/x');
        const log = newLog();
        const p = await log.pathFor(dir, BUILD_STAGE);
        fs.mkdirSync(p); // exists, but readFileSync cannot read a directory
        const msg = log.failureMessage('pnpm build', p, new BuildTermination(1, null));
        expect(msg).toContain(`could not read ${p}`);
        expect(msg).toContain(`FullLog : ${p}`);
    });

    it('says so rather than showing an empty tail when there is no log to read', async () => {
        expect(
            newLog().failureMessage('pnpm build', '/abs/nope.log', new BuildTermination(1, null)),
        ).toContain('(no log file at /abs/nope.log)');
    });

    // It must NOT teach the thing it exists to prevent.
    it('never tells the AI to re-run the build to see the errors', async () => {
        const msg = newLog().failureMessage(
            'pnpm build',
            '/abs/b.log',
            new BuildTermination(1, null),
        );
        expect(msg).not.toContain('Run THIS exact command to reproduce');
        expect(msg).toContain('Do NOT re-run the build to see them.');
    });
});
