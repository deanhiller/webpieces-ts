/**
 * wp-ci survivor watchdog.
 *
 * WHY this exists (see backlog/bug-wp-ci-hangs-forever-after-success-...md):
 * a CI step that runs `wp-ci` can hang FOREVER *after* every task has succeeded. GitHub Actions
 * ends a step when the step's stdout reaches EOF, not when the shell exits. Because the nx child
 * was handed the step's real stdout fd, any nx worker that outlives nx keeps that fd open, so the
 * step never ends — no output, no error, the whole job timeout burned with a zero exit code
 * already in hand. Three hours and eleven CI runs went into diagnosing that once.
 *
 * The cure is to make the failure SAY SO. Every nx step is spawned into its own process group, and
 * once the step has finished we wait for that group to drain. If anything is still alive when the
 * grace period expires we print every surviving pid with its full command line, kill the group so
 * the step's stdout can finally reach EOF, and exit non-zero. One log line replaces the whole
 * investigation.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';

import { toError } from '@webpieces/rules-config';

/** One process that is still alive after the step that spawned it has already finished. */
export class SurvivingProcess {
    readonly pid: number;
    readonly commandLine: string;

    constructor(pid: number, commandLine: string) {
        this.pid = pid;
        this.commandLine = commandLine;
    }
}

/**
 * Outcome of one `ps` sweep. `scanError` is non-null when `ps` itself could not be consulted
 * (not every container ships it) — that must never mask the real build result, so a failed scan
 * degrades to "assume drained" rather than throwing.
 */
export class SurvivorScan {
    readonly survivors: SurvivingProcess[];
    readonly scanError: string | null;

    constructor(survivors: SurvivingProcess[], scanError: string | null) {
        this.survivors = survivors;
        this.scanError = scanError;
    }
}

/** How long wp-ci may wait for survivors, and where that number came from (printed in the banner). */
export class GracePeriod {
    readonly millis: number;
    readonly source: string;

    constructor(millis: number, source: string) {
        this.millis = millis;
        this.source = source;
    }
}

/**
 * Enumerates the processes still running in a given process group, with full argv.
 * `ps -A -o pid=,pgid=,args=` is the one spelling that behaves the same on macOS (BSD ps) and Linux
 * (procps), which is why the fields are requested with trailing `=` (header suppression) instead of
 * `-eo`.
 */
export class ProcessGroupScanner {
    private static readonly PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
    private static readonly LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/;

    scan(processGroupId: number): SurvivorScan {
        const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,args='], {
            encoding: 'utf8',
            maxBuffer: ProcessGroupScanner.PS_MAX_BUFFER_BYTES,
        });
        if (result.error) {
            return new SurvivorScan([], `ps could not be run: ${toError(result.error).message}`);
        }
        if (result.status !== 0) {
            const stderr = (result.stderr ?? '').trim();
            return new SurvivorScan([], `ps exited with status ${result.status}: ${stderr}`);
        }
        return new SurvivorScan(this.parse(result.stdout ?? '', processGroupId), null);
    }

    /** Exposed so the parsing can be unit-tested against real macOS/Linux `ps` output. */
    parse(psOutput: string, processGroupId: number): SurvivingProcess[] {
        const found: SurvivingProcess[] = [];
        const lines = psOutput.split('\n');
        for (const line of lines) {
            const match = ProcessGroupScanner.LINE_PATTERN.exec(line);
            if (match === null) continue;
            const pid = Number(match[1]);
            const pgid = Number(match[2]);
            if (pgid !== processGroupId) continue;
            if (pid === process.pid) continue;
            found.push(new SurvivingProcess(pid, (match[3] ?? '').trim()));
        }
        return found;
    }
}

/**
 * Resolves the grace period. The default is 25 minutes: the client repo whose CI this incident came
 * from uses a 30-minute step timeout, so firing at 25 leaves headroom for the diagnostic to be
 * printed and flushed before the outer timeout kills everything (a diagnostic that races the job
 * timeout is no diagnostic at all).
 *
 * Overridable by ENV VAR rather than by a webpieces.config.json key on purpose: the config
 * validator that runs against this repo is one release behind the source, so a brand-new config key
 * is rejected as unknown and deadlocks the session. An env var ships in the same PR as its reader.
 */
export class GracePeriodResolver {
    static readonly DEFAULT_MINUTES = 25;
    static readonly ENV_VAR = 'WP_CI_SURVIVOR_GRACE_MINUTES';

    resolve(env: NodeJS.ProcessEnv): GracePeriod {
        const defaultMillis = GracePeriodResolver.DEFAULT_MINUTES * 60 * 1000;
        const raw = env[GracePeriodResolver.ENV_VAR];
        if (raw === undefined || raw.trim() === '') {
            return new GracePeriod(defaultMillis, `default ${GracePeriodResolver.DEFAULT_MINUTES} minutes`);
        }
        const minutes = Number(raw.trim());
        if (!Number.isFinite(minutes) || minutes < 0) {
            return new GracePeriod(
                defaultMillis,
                `default ${GracePeriodResolver.DEFAULT_MINUTES} minutes (ignored unparseable ${GracePeriodResolver.ENV_VAR}=${raw})`,
            );
        }
        return new GracePeriod(minutes * 60 * 1000, `${GracePeriodResolver.ENV_VAR}=${raw.trim()}`);
    }
}

/** Polls the process group until it drains, the deadline passes, or `ps` turns out to be unusable. */
export class SurvivorWatchdog {
    private readonly scanner: ProcessGroupScanner;
    private readonly pollIntervalMillis: number;

    constructor(scanner: ProcessGroupScanner, pollIntervalMillis: number) {
        this.scanner = scanner;
        this.pollIntervalMillis = pollIntervalMillis;
    }

    async waitForGroupToDrain(processGroupId: number, deadlineEpochMillis: number): Promise<SurvivorScan> {
        let scan = this.scanner.scan(processGroupId);
        while (scan.scanError === null && scan.survivors.length > 0 && Date.now() < deadlineEpochMillis) {
            await this.sleep(this.pollIntervalMillis);
            scan = this.scanner.scan(processGroupId);
        }
        return scan;
    }

    private sleep(millis: number): Promise<void> {
        return new Promise<void>((resolve: () => void) => {
            setTimeout(resolve, millis);
        });
    }
}

/**
 * Prints the banner with `fs.writeSync(2, …)` rather than `console.error`. The entire failure mode
 * being diagnosed is entangled stdio, and node's console is asynchronous on a pipe — a buffered
 * message can be lost when the process exits or is killed moments later. A synchronous write to fd 2
 * is on the wire before the next line of code runs.
 */
export class SurvivorReporter {
    private static readonly RULE = '='.repeat(78);
    private static readonly STDERR_FD = 2;

    /** The fd to write to; only tests ever pass anything other than stderr. */
    private readonly fd: number;

    constructor(fd: number = SurvivorReporter.STDERR_FD) {
        this.fd = fd;
    }

    reportSurvivors(stepLabel: string, gracePeriod: GracePeriod, survivors: SurvivingProcess[]): void {
        const lines: string[] = [];
        lines.push('');
        lines.push(SurvivorReporter.RULE);
        lines.push('❌ wp-ci ABORTED — processes SURVIVED a step that already finished');
        lines.push(SurvivorReporter.RULE);
        lines.push(`Step: ${stepLabel}`);
        lines.push(`Grace period: ${gracePeriod.source} (${gracePeriod.millis} ms) — expired.`);
        lines.push('');
        lines.push('These processes still hold this step\'s stdout open, so CI would hang forever');
        lines.push('with all work already done. They are listed with full command lines:');
        lines.push('');
        for (const survivor of survivors) {
            lines.push(`  pid ${survivor.pid}  ${survivor.commandLine}`);
        }
        lines.push('');
        lines.push(`Killing process group and failing. Raise/lower the wait with ${GracePeriodResolver.ENV_VAR}=<minutes>.`);
        lines.push(SurvivorReporter.RULE);
        lines.push('');
        this.writeStderr(lines.join('\n'));
    }

    reportScanUnavailable(stepLabel: string, scanError: string): void {
        this.writeStderr(`\n⚠️  wp-ci could not check for surviving processes after ${stepLabel}: ${scanError}\n`);
    }

    private writeStderr(text: string): void {
        // webpieces-disable no-unmanaged-exceptions -- a diagnostic must never replace the real failure
        try {
            fs.writeSync(this.fd, `${text}\n`);
        } catch (err: unknown) {
            const error = toError(err);
            console.error(`[wp-ci] could not write survivor diagnostic: ${error.message}`);
        }
    }
}

/** SIGKILLs a whole process group, so the leaked stdout fd is finally released and the step can end. */
export class ProcessGroupKiller {
    kill(processGroupId: number): void {
        // webpieces-disable no-unmanaged-exceptions -- the group may drain between scan and kill; that is a success, not an error
        try {
            process.kill(-processGroupId, 'SIGKILL');
        } catch (err: unknown) {
            const error = toError(err);
            console.error(`[wp-ci] could not kill process group ${processGroupId}: ${error.message}`);
        }
    }
}
