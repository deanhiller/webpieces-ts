import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    BuildsLog, BuildTicket, CliExitError, DEFAULT_MAX_CONCURRENT_BUILDS, DotWebpieces, HomeConfig,
    HomeConfigService, toError,
} from '@webpieces/rules-config';
import { BuildAffected, BuildGateOptions } from './build-affected';
import { BuildGateLog, REVIEW_STAGE } from './build-gate-log';
import { RepoConfigFixture } from './repo-config-testkit';

const dirs: string[] = [];
let written = '';

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    written = '';
});

/**
 * A loader pinned to a decision, so the suite never depends on whether the human running it happens to
 * have a `~/.webpieces/config.json`. Subclassing (rather than a hand-rolled double) keeps it type-checked
 * against the real class.
 */
class PinnedHomeConfig extends HomeConfigService {
    constructor(private readonly on: boolean) {
        super();
    }

    override load(): HomeConfig {
        return new HomeConfig(this.on, false, false, DEFAULT_MAX_CONCURRENT_BUILDS);
    }
}

/** A HOME with no `.webpieces` in it at all — the state essentially every consumer is in. */
function homeWithNoConfig(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nohome-')));
    dirs.push(dir);
    return dir;
}

/** The REAL loader, pointed at a HOME that has no config file — no stubbing anywhere in the path. */
class NoHomeConfigFile extends HomeConfigService {
    constructor(private readonly home: string) {
        super();
    }

    override load(): HomeConfig {
        return super.load(this.home);
    }
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
    return new TempHomeBuildsLog(homeWithNoConfig());
}

function gate(captureOn: boolean): BuildAffected {
    return new BuildAffected(new PinnedHomeConfig(captureOn), new BuildGateLog(), builds());
}

/** The PR-flow stages pass alwaysCapture=false; `wp-build` is the one caller that passes true. */
function opts(alwaysCapture = false): BuildGateOptions {
    return new BuildGateOptions(
        '🛠️  Build gate', 'pnpm wp-review-upsert-pr', 'Build failed — nothing was briefed.', REVIEW_STAGE, alwaysCapture);
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

async function runExpectingFailure(affected: BuildAffected, dir: string, o: BuildGateOptions = opts()): Promise<CliExitError> {
    let caught: CliExitError | null = null;
    await captureStdout(async (): Promise<void> => {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the CliExitError IS the assertion subject
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await affected.runBuildGate(dir, o);
        } catch (err: unknown) {
            const error = toError(err);
            caught = error as CliExitError;
        }
    });
    if (caught === null) throw new Error('the build gate was expected to fail and did not');
    return caught;
}

/**
 * ══ THE PATH EVERY OTHER USER OF THESE PACKAGES IS ON ══════════════════════════════════════════════
 *
 * `~/.webpieces/config.json` is OPTIONAL and essentially nobody has one. These cases run the REAL
 * HomeConfigService against a HOME with no such file — nothing stubbed — and assert the gate is
 * byte-for-byte what it was before this feature existed.
 */
describe('NO ~/.webpieces/config.json at all — today\'s behaviour, byte for byte', () => {
    it('fails with the pre-existing text and writes no log file', async () => {
        const dir = repoWithBuild('echo compiling; exit 4');
        const err = await runExpectingFailure(
            new BuildAffected(new NoHomeConfigFile(homeWithNoConfig()), new BuildGateLog(), builds()), dir);
        expect(err.exitCode).toBe(4);
        expect(err.message).toContain('Run THIS exact command to reproduce and fix all errors');
        expect(err.message).not.toContain('.webpieces/logs');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('passes with the pre-existing two lines, and never throws over the missing file', async () => {
        const dir = repoWithBuild('echo compiling');
        await captureStdout(async (): Promise<void> => {
            await new BuildAffected(new NoHomeConfigFile(homeWithNoConfig()), new BuildGateLog(), builds()).runBuildGate(dir, opts());
        });
        expect(written).toContain('🛠️  Build gate: echo compiling');
        expect(written).toContain('✅ Build passed.');
        expect(written).not.toContain('.webpieces');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('reports capture as disabled', () => {
        expect(new BuildAffected(new NoHomeConfigFile(homeWithNoConfig()), new BuildGateLog(), builds()).isCaptureEnabled()).toBe(false);
    });
});

describe('build gate with capture OFF', () => {
    /**
     * The load-bearing case. Without the opt-in file the gate must behave EXACTLY as it did before this
     * feature existed: the old failure text, the old exit code, and NOTHING written to .webpieces/logs.
     */
    it('keeps the pre-existing failure text and writes no log file', async () => {
        const dir = repoWithBuild('echo compiling; exit 4');
        const err = await runExpectingFailure(gate(false), dir);
        expect(err.exitCode).toBe(4);
        expect(err.message).toContain('Build failed — nothing was briefed.');
        expect(err.message).toContain('Run THIS exact command to reproduce and fix all errors');
        expect(err.message).toContain('echo compiling; exit 4');
        expect(err.message).not.toContain('.webpieces/logs');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('prints only the command and the pass line on success, and writes no log file', async () => {
        const dir = repoWithBuild('echo compiling');
        await captureStdout(async (): Promise<void> => { await gate(false).runBuildGate(dir, opts()); });
        expect(written).toContain('🛠️  Build gate: echo compiling');
        expect(written).toContain('✅ Build passed.');
        expect(written).not.toContain('.webpieces/logs');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('reports capture as disabled', () => {
        expect(gate(false).isCaptureEnabled()).toBe(false);
    });
});

describe('build gate with capture ON (opted in)', () => {
    it('on FAILURE hands back the pointer at the log, and the log holds the real output', async () => {
        const dir = repoWithBuild('echo TS2554-somewhere 1>&2; exit 4');
        const err = await runExpectingFailure(gate(true), dir);
        expect(err.exitCode).toBe(4);

        const logPath = new BuildGateLog().existingLogFor(dir, REVIEW_STAGE);
        expect(logPath).not.toBe('');
        expect(fs.readFileSync(logPath, 'utf8')).toContain('TS2554-somewhere');

        expect(err.message).toContain('Build Failed: echo TS2554-somewhere 1>&2; exit 4');
        expect(err.message).toContain(`FullLog : ${logPath}`);
        expect(err.message).toContain('If you do not see failures in that log, report that to the user and stop.');
        // The point of the whole feature: it must NOT tell the agent to build again.
        expect(err.message).not.toContain('Run THIS exact command to reproduce');
    });

    it('on SUCCESS says so and names the log, rather than reprinting the build', async () => {
        const dir = repoWithBuild('echo compiling');
        await captureStdout(async (): Promise<void> => { await gate(true).runBuildGate(dir, opts()); });
        expect(written).toContain('🛠️  Build gate: echo compiling');
        expect(written).toContain('Build success');
        expect(written).toContain(`FullLog : ${new BuildGateLog().existingLogFor(dir, REVIEW_STAGE)}`);
        // Streaming the build to the console is exactly what made an agent re-run it; it must not happen.
        // The command is ANNOUNCED (`…: echo compiling`), so the test is that no line IS the build's output.
        expect(written.split('\n')).not.toContain('compiling');
        expect(fs.readFileSync(new BuildGateLog().existingLogFor(dir, REVIEW_STAGE), 'utf8')).toContain('compiling');
    });

    it('reports capture as enabled', () => {
        expect(gate(true).isCaptureEnabled()).toBe(true);
    });
});

/**
 * `wp-build`'s contract IS the log file — its console output is a heartbeat and a pointer at that file —
 * so it captures on a machine with no `~/.webpieces/config.json`, which is every machine.
 */
describe('alwaysCapture: the wp-build path, with the opt-in OFF', () => {
    it('captures anyway and names the log on success', async () => {
        const dir = repoWithBuild('echo compiling');
        await captureStdout(async (): Promise<void> => { await gate(false).runBuildGate(dir, opts(true)); });
        expect(written).toContain('Build success');
        expect(written).toContain('FullLog : ');
        expect(fs.readFileSync(new BuildGateLog().existingLogFor(dir, REVIEW_STAGE), 'utf8')).toContain('compiling');
    });

    it('captures anyway on failure, and still exits non-zero', async () => {
        const dir = repoWithBuild('echo boom 1>&2; exit 4');
        const err = await runExpectingFailure(gate(false), dir, opts(true));
        expect(err.exitCode).toBe(4);
        expect(err.message).toContain('Build Failed:');
        expect(fs.readFileSync(new BuildGateLog().existingLogFor(dir, REVIEW_STAGE), 'utf8')).toContain('boom');
    });
});

describe('BuildGateOptions', () => {
    // No default for `stage`: a default would silently let two stages share one log file.
    it('requires a stage', () => {
        expect(opts().stage).toBe(REVIEW_STAGE);
    });

    // No default for alwaysCapture either: whether the console is the output or the log is decides what
    // the caller is handed, and that may never be inherited by accident.
    it('requires an alwaysCapture decision', () => {
        expect(opts().alwaysCapture).toBe(false);
        expect(opts(true).alwaysCapture).toBe(true);
    });
});
