import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';

import { GateLogFile } from './gate-log-file';
import { StageOutputLog } from './stage-output-log';

// ─── Why ───────────────────────────────────────────────────────────────────────────────────────────────
// The build gate already builds everything. When the output only ever went to the CONSOLE, an agent that
// wanted a different slice of it re-ran the WHOLE BUILD to get it: one measured session spent 23.9 minutes
// across nine `nx affected` runs, five of them with NO code change in between — `| tail -50`, then
// `> /tmp/file`, then `| grep`, then `| sed -n '1100,1230p'`. ~19 minutes spent re-reading a log.
//
// So the build's output is not streamed; it is REDIRECTED, in full, to a file whose path the caller is
// handed on completion. Reading a different slice is then a `grep` of a FILE, not a second build.
//
// ─── Why a redirect and not `tee` ──────────────────────────────────────────────────────────────────────
// An earlier cut of this used `cmd 2>&1 | tee log`, to keep the terminal byte-identical. That is what
// makes the transcript expensive in the first place — an AI caller carries every line of it in context.
// The redirect keeps the console to a handful of lines (a heartbeat, then a pointer at the file), which is
// the entire productivity claim. Losing `tee` also deletes the `$?`-into-a-side-file dance it needed: in a
// pipeline the shell reports TEE's status, which is 0 whether the build passed or failed, so the status
// had to be smuggled out through a side file. With no pipe, the child's own exit code IS the answer.
//
// ─── Why async (`spawn`, not `spawnSync`) ──────────────────────────────────────────────────────────────
// `spawnSync` blocks the event loop for the length of the build, so NOTHING can print while it runs — and
// a silent terminal for 3–7 minutes is indistinguishable from a hang. The heartbeat is the reason this is
// async, and it is why `run` returns a Promise and `BuildAffected.runBuildGate` is async with it.
//
// It is also the reason the heartbeat goes through `StageOutputLog.say` rather than `process.stdout` —
// stage ② and stage ③ capture their own console output to a file, and a heartbeat captured into a file is
// a heartbeat nobody can see. The 600-second watchdog that kills a silent command does not read files.

/** How often the heartbeat reports the log's size. Hardcoded: a knob here would be a knob the PR gate's
 * own build never receives, and the two must stay the same command. */
export const HEARTBEAT_MS = 10_000;

/** How many trailing log lines the failure message echoes, so the immediate cause is visible without a
 * second command. Small on purpose — the FULL log is one grep away and the message must not become the
 * transcript it exists to replace. */
export const FAILURE_TAIL_LINES = 20;

/**
 * Which stage's gate is being captured. The value decides the log FILENAME.
 */
export const REVIEW_STAGE = 'review';
export const FINISH_STAGE = 'finish';
// `wp-build`, which is not a stage of the PR flow but runs the SAME gate (BuildAffected.runBuildGate).
export const BUILD_STAGE = 'build';

/** The one fixed log name — see BuildGateLog.fileNameFor for why only `wp-build` gets one. */
export const BUILD_LOG_NAME = 'build.log';

/**
 * The heartbeat's state: the line count reported on the PREVIOUS tick, so a tick that has not moved can
 * say so. Stateful per RUN, which is why it is constructed per run rather than injected.
 *
 * `still` is the load-bearing word. A build that is linking, or waiting on a cold nx cache, produces no
 * output for minutes; without `still` the caller sees the same number twice and cannot tell a stalled
 * BUILD from a stalled REPORTER.
 */
export class BuildLogHeartbeat {
    private previous: number | null = null;

    constructor(
        private readonly files: GateLogFile,
        private readonly logPath: string,
        private readonly displayPath: string,
    ) {}

    /** One heartbeat line — `<path> size <n> lines`, plus ` still` when <n> has not moved. */
    tick(): string {
        const count = this.files.lineCount(this.logPath);
        const still = this.previous !== null && count === this.previous ? ' still' : '';
        this.previous = count;
        return `${this.displayPath} size ${count} lines${still}`;
    }
}

/**
 * Captures the build gate's full output to a file, reports progress while it runs, and renders the
 * pointer the caller is handed instead of a rebuild instruction.
 *
 * WHERE the file goes, how the previous run is kept, and what the pointer reads like are `GateLogFile`'s
 * — one mechanism, shared with the stage console log, so there is a single answer to "where is it?".
 *
 * ─── Two naming schemes, one rule each ─────────────────────────────────────────────────────────────────
 *   • `wp-build` (BUILD_STAGE) writes ONE fixed path, `.webpieces/build.log`. It is fixed because a HUMAN
 *     OR AN AGENT TYPES IT — `grep -n error .webpieces/build.log` has to be writable from memory, and a
 *     name carrying a branch and a sha is not. History comes from the rotation instead.
 *   • stage ② and stage ③ write `logs/build-gate-<stage>-<branch>-<shortSha>.log`, because those two
 *     gates CAN run against one commit and a failure message from one must not be pointing at a file the
 *     other overwrote. Nobody types those names; the failure message prints them.
 *
 * ─── Concurrency ───────────────────────────────────────────────────────────────────────────────────────
 * The DIRECTORY is `dotWebpieces.local()`-scoped — `<primary>/.webpieces/worktrees/<git worktree name>/`
 * in a linked worktree — so "N agents in N worktrees" is safe by construction rather than by naming. The
 * residual case is two builds in the SAME worktree at once, which is already unsupported: both would be
 * driving one git index.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildGateLog {
    constructor(
        private readonly files: GateLogFile,
        private readonly stageConsole: StageOutputLog,
    ) {}

    /** Absolute path of the log for `stage` at the current HEAD, creating its directory. */
    pathFor(repoRoot: string, stage: string): string {
        return this.resolvePath(repoRoot, stage);
    }

    /** The same path, and '' when no log has been WRITTEN there yet. Used by finish's skip path. */
    existingLogFor(repoRoot: string, stage: string): string {
        const file = this.resolvePath(repoRoot, stage);
        return fs.existsSync(file) ? file : '';
    }

    /** `build.log` for `wp-build`; `build-gate-<stage>-<branch>-<shortSha>.log` for the PR-flow stages. */
    fileNameFor(repoRoot: string, stage: string): string {
        if (stage === BUILD_STAGE) return BUILD_LOG_NAME;
        const branch = this.slug(this.git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']));
        const sha = this.slug(this.git(repoRoot, ['rev-parse', '--short', 'HEAD']));
        return `build-gate-${this.slug(stage)}-${branch === '' ? 'nobranch' : branch}-${sha === '' ? 'nosha' : sha}.log`;
    }

    /**
     * Run `buildCommand` with its stdout AND stderr redirected in full to `logPath`, printing a heartbeat
     * every HEARTBEAT_MS so the caller can see it is alive. Returns the BUILD's exit code. Nothing is
     * truncated and nothing is streamed.
     */
    async run(repoRoot: string, buildCommand: string, logPath: string): Promise<number> {
        this.files.rotate(logPath);
        const fd = fs.openSync(logPath, 'w');
        const heartbeat = new BuildLogHeartbeat(this.files, logPath, this.files.displayPath(repoRoot, logPath));
        const timer = setInterval((): void => { this.stageConsole.say(`${heartbeat.tick()}\n`); }, HEARTBEAT_MS);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the timer and the fd MUST be released
        // whatever the child does, and the exit code is returned rather than thrown so runBuildGate owns
        // the one CliExitError.
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await this.awaitExit(spawn(buildCommand, { cwd: repoRoot, shell: true, stdio: ['ignore', fd, fd] }), fd);
        } finally {
            clearInterval(timer);
            fs.closeSync(fd);
        }
    }

    /**
     * The success summary: the caller is told WHERE the full output is, not handed the output.
     */
    successMessage(logPath: string): string {
        return `\nBuild success\n${this.files.pointer(logPath)}`;
    }

    /**
     * The ENTIRE message the caller gets on a failed build. It names the log, echoes the last
     * FAILURE_TAIL_LINES lines so the immediate cause needs no second command, and forbids the rebuild
     * this whole file exists to prevent.
     *
     * The last sentence is not filler. If the log holds no visible failure then something upstream is wrong
     * (a runner that died without printing, a truncated redirect), and the worst possible response is an
     * agent guessing or rebuilding — so it is told to surface the contradiction to the human and stop.
     */
    failureMessage(buildCommand: string, logPath: string): string {
        return `\nBuild Failed: ${buildCommand}\n${this.files.pointer(logPath)}\n` +
            `Last ${FAILURE_TAIL_LINES} lines of that log:\n${this.files.tail(logPath, FAILURE_TAIL_LINES)}\n` +
            `Read that FILE for the failures. Do NOT re-run the build to see them.\n` +
            `If you do not see failures in that log, report that to the user and stop.\n`;
    }

    // Resolve, and wait for, the child's exit code. A spawn that never starts (a shell that is missing, a
    // cwd that vanished) fails CLOSED to 1 — calling a build that never ran green is the one outcome that
    // must be impossible — and the reason is APPENDED TO THE LOG, so the failure message's pointer still
    // leads to it rather than to an empty file.
    private awaitExit(child: ChildProcess, fd: number): Promise<number> {
        return new Promise<number>((resolve: (code: number) => void): void => {
            child.on('error', (err: Error): void => {
                fs.writeSync(fd, `\nThe build command could not be started: ${err.message}\n`);
                resolve(1);
            });
            child.on('close', (code: number | null): void => { resolve(code ?? 1); });
        });
    }

    private resolvePath(repoRoot: string, stage: string): string {
        const name = this.fileNameFor(repoRoot, stage);
        // `wp-build`'s log sits at the ROOT of the state dir, not under `logs/`, because it is the one log
        // path a person types from memory. Everything else keeps the per-commit names in `logs/`.
        return stage === BUILD_STAGE ? this.files.localPath(repoRoot, name) : this.files.logsPath(repoRoot, name);
    }

    // Anything that is not a filename-safe character becomes '-', so `dean/feat` cannot create directories.
    private slug(value: string): string {
        return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    }

    // One local git read. Fails SOFT to '' — a missing branch/sha degrades the FILENAME, and degrading a
    // filename may never be the reason a build gate does not run.
    private git(repoRoot: string, args: string[]): string {
        const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
        if (result.status !== 0) return '';
        return (result.stdout ?? '').trim();
    }
}
