import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliExitError, HomeConfig, HomeConfigService, toError } from '@webpieces/rules-config';
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
        return new HomeConfig(this.on);
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

function gate(captureOn: boolean): BuildAffected {
    return new BuildAffected(new PinnedHomeConfig(captureOn), new BuildGateLog());
}

function opts(): BuildGateOptions {
    return new BuildGateOptions('🛠️  Build gate', 'pnpm wp-review-upsert-pr', 'Build failed — nothing was briefed.', REVIEW_STAGE);
}

/** Swallow the gate's own stdout so the suite output stays readable, and keep what it wrote. */
function captureStdout(body: () => void): void {
    const real = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- matching node's overloaded write signature for a test double
    process.stdout.write = ((chunk: string): boolean => { written += chunk; return true; }) as typeof process.stdout.write;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: stdout MUST be restored even when the gate throws
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        body();
    } finally {
        process.stdout.write = real;
    }
}

function runExpectingFailure(affected: BuildAffected, dir: string): CliExitError {
    let caught: CliExitError | null = null;
    captureStdout((): void => {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the CliExitError IS the assertion subject
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            affected.runBuildGate(dir, opts());
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
    it('fails with the pre-existing text and writes no log file', () => {
        const dir = repoWithBuild('echo compiling; exit 4');
        const err = runExpectingFailure(new BuildAffected(new NoHomeConfigFile(homeWithNoConfig()), new BuildGateLog()), dir);
        expect(err.exitCode).toBe(4);
        expect(err.message).toContain('Run THIS exact command to reproduce and fix all errors');
        expect(err.message).not.toContain('.webpieces/logs');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('passes with the pre-existing two lines, and never throws over the missing file', () => {
        const dir = repoWithBuild('echo compiling');
        captureStdout((): void => {
            new BuildAffected(new NoHomeConfigFile(homeWithNoConfig()), new BuildGateLog()).runBuildGate(dir, opts());
        });
        expect(written).toContain('🛠️  Build gate: echo compiling');
        expect(written).toContain('✅ Build passed.');
        expect(written).not.toContain('.webpieces');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('reports capture as disabled', () => {
        expect(new BuildAffected(new NoHomeConfigFile(homeWithNoConfig()), new BuildGateLog()).isCaptureEnabled()).toBe(false);
    });
});

describe('build gate with capture OFF', () => {
    /**
     * The load-bearing case. Without the opt-in file the gate must behave EXACTLY as it did before this
     * feature existed: the old failure text, the old exit code, and NOTHING written to .webpieces/logs.
     */
    it('keeps the pre-existing failure text and writes no log file', () => {
        const dir = repoWithBuild('echo compiling; exit 4');
        const err = runExpectingFailure(gate(false), dir);
        expect(err.exitCode).toBe(4);
        expect(err.message).toContain('Build failed — nothing was briefed.');
        expect(err.message).toContain('Run THIS exact command to reproduce and fix all errors');
        expect(err.message).toContain('echo compiling; exit 4');
        expect(err.message).not.toContain('.webpieces/logs');
        expect(fs.existsSync(path.join(dir, '.webpieces', 'logs'))).toBe(false);
    });

    it('prints only the command and the pass line on success, and writes no log file', () => {
        const dir = repoWithBuild('echo compiling');
        captureStdout((): void => { gate(false).runBuildGate(dir, opts()); });
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
    it('on FAILURE hands back the small pointer, and the log holds the real output', () => {
        const dir = repoWithBuild('echo TS2554-somewhere 1>&2; exit 4');
        const err = runExpectingFailure(gate(true), dir);
        expect(err.exitCode).toBe(4);

        const logPath = new BuildGateLog().existingLogFor(dir, REVIEW_STAGE);
        expect(logPath).not.toBe('');
        expect(fs.readFileSync(logPath, 'utf8')).toContain('TS2554-somewhere');

        expect(err.message).toContain('The CI build failed');
        expect(err.message).toContain(`echo TS2554-somewhere 1>&2; exit 4 > ${logPath}`);
        expect(err.message).toContain('If you do not see failures in that log, report that to the user and stop.');
        // The point of the whole feature: it must NOT tell the agent to build again.
        expect(err.message).not.toContain('Run THIS exact command to reproduce');
        expect(err.message).not.toContain('TS2554-somewhere\n');
    });

    it('on SUCCESS adds no noise — same two lines as before, log written quietly', () => {
        const dir = repoWithBuild('echo compiling');
        captureStdout((): void => { gate(true).runBuildGate(dir, opts()); });
        expect(written).toContain('🛠️  Build gate: echo compiling');
        expect(written).toContain('✅ Build passed.');
        expect(written).not.toContain('.webpieces/logs');
        expect(fs.readFileSync(new BuildGateLog().existingLogFor(dir, REVIEW_STAGE), 'utf8')).toContain('compiling');
    });

    it('reports capture as enabled', () => {
        expect(gate(true).isCaptureEnabled()).toBe(true);
    });
});

describe('BuildGateOptions', () => {
    // No default for `stage`: a default would silently let two stages share one log file.
    it('requires a stage', () => {
        expect(opts().stage).toBe(REVIEW_STAGE);
    });
});
