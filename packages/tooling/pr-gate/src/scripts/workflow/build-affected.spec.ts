import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildsLog, BuildTicket, CliExitError, DotWebpieces, toError } from '@webpieces/rules-config';
import { BuildAffected, BuildGateOptions } from './build-affected';
import { BuildGateLog, REVIEW_STAGE } from './build-gate-log';
import { GateLogFile } from './gate-log-file';
import { StageOutputLog } from './stage-output-log';
import { RepoConfigFixture } from './repo-config-testkit';

const dirs: string[] = [];
let written = '';

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    written = '';
});

/** A HOME with no `.webpieces` in it at all — where the throwaway build ledger is pointed. */
function tempHome(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nohome-')));
    dirs.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A git repo carrying THIS repo's own webpieces.config.json (see RepoConfigFixture), with
 * `buildCommand` swapped for `command`. Using the real config means the spec faces the same validator
 * the tool really faces.
 */
function repoWithBuild(command: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-buildgate-')));
    dirs.push(dir);
    const fixture = new RepoConfigFixture();
    const config = fixture.load();
    // webpieces-disable no-any-unknown -- narrowing one nested section
    const commands = config['commands'] as Record<string, Record<string, unknown>>;
    commands['pr-gate']['buildCommand'] = command;
    fixture.writeTo(dir, config);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    git(dir, 'config', 'user.email', 'spec@example.com');
    git(dir, 'config', 'user.name', 'spec');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'checkout', '-q', '-b', 'dean/gate');
    return dir;
}

/**
 * The REAL ledger, pointed at a throwaway HOME. `BuildsLog`'s public methods default `homeDir` to
 * `os.homedir()`, which is right in production and unacceptable in a spec — an unpinned one would append
 * a row to the DEVELOPER's `~/.webpieces/builds.log` every time this suite ran. Subclassing keeps the
 * real code under test (rotation, locking, row rendering) while the bytes land in a temp directory.
 */
class TempHomeBuildsLog extends BuildsLog {
    constructor(private readonly home: string) {
        super(new DotWebpieces());
    }

    override start(by: string, startDir: string): BuildTicket {
        return super.start(by, startDir, this.home);
    }

    override finish(ticket: BuildTicket, exitCode: number): void {
        super.finish(ticket, exitCode, this.home);
    }
}

function builds(): TempHomeBuildsLog {
    return new TempHomeBuildsLog(tempHome());
}

function buildLog(): BuildGateLog {
    const files = new GateLogFile();
    return new BuildGateLog(files, new StageOutputLog(files));
}

function gate(): BuildAffected {
    const files = new GateLogFile();
    const stageConsole = new StageOutputLog(files);
    return new BuildAffected(new BuildGateLog(files, stageConsole), builds(), stageConsole);
}

function opts(): BuildGateOptions {
    return new BuildGateOptions(
        '🛠️  Build gate', 'pnpm wp-review-upsert-pr', 'Build failed — nothing was briefed.', REVIEW_STAGE);
}

/** Swallow the gate's own stdout so the suite output stays readable, and keep what it wrote. */
async function captureStdout(body: () => Promise<void>): Promise<void> {
    const real = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- matching node's overloaded write signature for a test double
    process.stdout.write = ((chunk: string): boolean => { written += chunk; return true; }) as typeof process.stdout.write;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: stdout MUST be restored even when the gate throws
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await body();
    } finally {
        process.stdout.write = real;
    }
}

async function runExpectingFailure(affected: BuildAffected, dir: string): Promise<CliExitError> {
    let caught: CliExitError | null = null;
    await captureStdout(async (): Promise<void> => {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the CliExitError IS the assertion subject
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await affected.runBuildGate(dir, opts());
        } catch (err: unknown) {
            const error = toError(err);
            caught = error as CliExitError;
        }
    });
    if (caught === null) throw new Error('the build gate was expected to fail and did not');
    return caught;
}

/**
 * ══ CAPTURING IS NOT OPTIONAL ══════════════════════════════════════════════════════════════════════
 *
 * It used to be, behind `experimental.buildGateLogCapture` in the machine-local
 * `~/.webpieces/config.json` — a file essentially nobody has, so essentially every build streamed to
 * the terminal and every failure said "run this command again yourself". Both halves of that were the
 * problem: the flood is why agents piped these commands (and a pipe withholds every byte until exit,
 * so the 600s watchdog killed the build), and the rebuild instruction is the single most expensive
 * thing an agent can be told.
 *
 * There is now ONE path. Every build the gate runs writes its full output to a file, prints a
 * heartbeat, and hands back a pointer. These cases pin that there is no second behaviour to select.
 */
describe('the build gate always captures, whatever is on the machine', () => {
    it('on FAILURE hands back the pointer at the log, and the log holds the real output', async () => {
        const dir = repoWithBuild('echo TS2554-somewhere 1>&2; exit 4');
        const err = await runExpectingFailure(gate(), dir);
        expect(err.exitCode).toBe(4);

        const logPath = buildLog().existingLogFor(dir, REVIEW_STAGE);
        expect(logPath).not.toBe('');
        expect(fs.readFileSync(logPath, 'utf8')).toContain('TS2554-somewhere');

        expect(err.message).toContain('Build failed — nothing was briefed.');
        expect(err.message).toContain('Build Failed: echo TS2554-somewhere 1>&2; exit 4');
        expect(err.message).toContain(`FullLog : ${logPath}`);
        expect(err.message).toContain('If you do not see failures in that log, report that to the user and stop.');
        // The point of the whole feature: it must NOT tell the agent to build again.
        expect(err.message).not.toContain('Run THIS exact command to reproduce');
    });

    it('names the command to re-run AFTER the fix, which is the stage rather than the build', async () => {
        const dir = repoWithBuild('exit 4');
        const err = await runExpectingFailure(gate(), dir);
        expect(err.message).toContain('re-run pnpm wp-review-upsert-pr');
    });

    it('on SUCCESS says so and names the log, rather than reprinting the build', async () => {
        const dir = repoWithBuild('echo compiling');
        await captureStdout(async (): Promise<void> => { await gate().runBuildGate(dir, opts()); });
        expect(written).toContain('🛠️  Build gate: echo compiling');
        expect(written).toContain('Build success');
        expect(written).toContain(`FullLog : ${buildLog().existingLogFor(dir, REVIEW_STAGE)}`);
        // Streaming the build to the console is exactly what made an agent re-run it; it must not happen.
        // The command is ANNOUNCED (`…: echo compiling`), so the test is that no line IS the build's output.
        expect(written.split('\n')).not.toContain('compiling');
        expect(fs.readFileSync(buildLog().existingLogFor(dir, REVIEW_STAGE), 'utf8')).toContain('compiling');
    });

    // There is no `alwaysCapture` flag to pass any more, and no home-config key to read: a repo with no
    // `~/.webpieces` anywhere still gets a log. Asserted through the FILE rather than through a getter,
    // because the file is the contract.
    it('writes the log for a repo whose machine has no ~/.webpieces/config.json', async () => {
        const dir = repoWithBuild('echo compiling');
        await captureStdout(async (): Promise<void> => { await gate().runBuildGate(dir, opts()); });
        expect(buildLog().existingLogFor(dir, REVIEW_STAGE)).not.toBe('');
    });
});

describe('BuildGateOptions', () => {
    // No default for `stage`: a default would silently let two stages share one log file.
    it('requires a stage', () => {
        expect(opts().stage).toBe(REVIEW_STAGE);
    });
});
