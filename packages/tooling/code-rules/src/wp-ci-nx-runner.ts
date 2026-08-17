/**
 * Runs one `nx` step for wp-ci and refuses to leave survivors behind.
 *
 * The step is spawned DETACHED, which on POSIX makes the child a process-group leader (pgid == pid).
 * That group id is the handle everything else needs: it is what `ps` is filtered on to enumerate
 * workers that outlived nx, and it is what gets SIGKILLed so the step's stdout can reach EOF.
 * Without the group there is no way to tell an orphaned nx worker from an unrelated process, because
 * orphans are re-parented away from the tree that spawned them.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { toError } from '@webpieces/rules-config';
import { GracePeriod, ProcessGroupKiller, SurvivorReporter, SurvivorWatchdog } from './wp-ci-survivors';

export class NxStepRunner {
    /**
     * Distinct from 1 so a survivor abort is greppable in CI history and cannot be confused with an
     * ordinary red build.
     */
    static readonly SURVIVOR_TIMEOUT_EXIT_CODE = 75;

    private readonly root: string;
    private readonly gracePeriod: GracePeriod;
    private readonly watchdog: SurvivorWatchdog;
    private readonly reporter: SurvivorReporter;
    private readonly killer: ProcessGroupKiller;
    /**
     * ONE budget for the whole wp-ci process, fixed at construction (i.e. at wp-ci start) rather
     * than per step. A per-step grace period would multiply by the number of steps and could still
     * overrun the outer CI timeout the number was chosen against.
     */
    private readonly deadlineEpochMillis: number;

    constructor(
        root: string,
        gracePeriod: GracePeriod,
        watchdog: SurvivorWatchdog,
        reporter: SurvivorReporter,
        killer: ProcessGroupKiller,
    ) {
        this.root = root;
        this.gracePeriod = gracePeriod;
        this.watchdog = watchdog;
        this.reporter = reporter;
        this.killer = killer;
        this.deadlineEpochMillis = Date.now() + gracePeriod.millis;
    }

    async run(args: string[], stepLabel: string): Promise<number> {
        const child = spawn(this.nxBin(), args, { stdio: 'inherit', cwd: this.root, detached: true });
        const exitCode = await this.awaitExit(child);

        const processGroupId = child.pid;
        if (processGroupId === undefined) return exitCode;
        return this.settleStep(processGroupId, stepLabel, exitCode);
    }

    /**
     * The whole point of the fix: a step is not finished when its child exits, it is finished when
     * nothing it spawned is left holding the step's stdout. Split out from `run` so it is unit
     * testable without spawning nx.
     */
    async settleStep(processGroupId: number, stepLabel: string, exitCode: number): Promise<number> {
        const scan = await this.watchdog.waitForGroupToDrain(processGroupId, this.deadlineEpochMillis);
        if (scan.scanError !== null) {
            this.reporter.reportScanUnavailable(stepLabel, scan.scanError);
            return exitCode;
        }
        if (scan.survivors.length === 0) return exitCode;

        this.reporter.reportSurvivors(stepLabel, this.gracePeriod, scan.survivors);
        this.killer.kill(processGroupId);
        return NxStepRunner.SURVIVOR_TIMEOUT_EXIT_CODE;
    }

    private awaitExit(child: ChildProcess): Promise<number> {
        return new Promise<number>((resolve: (code: number) => void) => {
            child.on('error', (err: Error) => {
                console.error(`[wp-ci] could not run nx: ${toError(err).message}`);
                resolve(1);
            });
            child.on('close', (code: number | null) => {
                resolve(code === null ? 1 : code);
            });
        });
    }

    private nxBin(): string {
        const local = path.join(this.root, 'node_modules', '.bin', 'nx');
        return fs.existsSync(local) ? local : 'nx';
    }
}
