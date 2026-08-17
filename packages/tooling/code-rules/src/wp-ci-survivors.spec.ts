import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    GracePeriod,
    GracePeriodResolver,
    ProcessGroupKiller,
    ProcessGroupScanner,
    SurvivingProcess,
    SurvivorReporter,
    SurvivorScan,
    SurvivorWatchdog,
} from './wp-ci-survivors';
import { NxStepRunner } from './wp-ci-nx-runner';

// Real `ps -A -o pid=,pgid=,args=` output: macOS pads pids, Linux does not, and argv contains spaces.
const PS_OUTPUT = [
    '  501   501 /sbin/launchd',
    '19424 19424 node /repo/node_modules/.bin/nx affected --target=ci',
    '20034 19424 /usr/local/bin/node /repo/node_modules/nx/src/native/nx.js --worker=1',
    '20051 19424 sh -c tsc -p tsconfig.json',
    '20099 20099 node /repo/other-thing.js',
    '',
].join('\n');

class FakeScanner extends ProcessGroupScanner {
    private readonly scans: SurvivorScan[];
    calls = 0;

    constructor(scans: SurvivorScan[]) {
        super();
        this.scans = scans;
    }

    override scan(): SurvivorScan {
        const index = Math.min(this.calls, this.scans.length - 1);
        this.calls = this.calls + 1;
        return this.scans[index]!;
    }
}

describe('ProcessGroupScanner.parse', () => {
    it('returns every pid in the group with its FULL command line', () => {
        const survivors = new ProcessGroupScanner().parse(PS_OUTPUT, 19424);
        expect(survivors.map((s: SurvivingProcess) => s.pid)).toEqual([19424, 20034, 20051]);
        expect(survivors[2]!.commandLine).toBe('sh -c tsc -p tsconfig.json');
    });

    it('ignores processes in other groups', () => {
        const survivors = new ProcessGroupScanner().parse(PS_OUTPUT, 20099);
        expect(survivors).toHaveLength(1);
        expect(survivors[0]!.commandLine).toBe('node /repo/other-thing.js');
    });

    it('returns nothing for a drained group', () => {
        expect(new ProcessGroupScanner().parse(PS_OUTPUT, 99999)).toEqual([]);
    });

    it('degrades gracefully instead of throwing when ps is absent or the group is gone', () => {
        const scan = new ProcessGroupScanner().scan(-1);
        expect(scan.survivors).toEqual([]);
    });
});

describe('GracePeriodResolver', () => {
    it('defaults to 25 minutes — 5 minutes of headroom under a 30 minute CI timeout', () => {
        const period = new GracePeriodResolver().resolve({});
        expect(GracePeriodResolver.DEFAULT_MINUTES).toBe(25);
        expect(period.millis).toBe(25 * 60 * 1000);
        expect(period.source).toContain('25');
    });

    it('honours the env var override', () => {
        const period = new GracePeriodResolver().resolve({ WP_CI_SURVIVOR_GRACE_MINUTES: '2' });
        expect(period.millis).toBe(2 * 60 * 1000);
        expect(period.source).toBe('WP_CI_SURVIVOR_GRACE_MINUTES=2');
    });

    it('falls back to the default (and says so) on an unparseable override', () => {
        const period = new GracePeriodResolver().resolve({ WP_CI_SURVIVOR_GRACE_MINUTES: 'soon' });
        expect(period.millis).toBe(25 * 60 * 1000);
        expect(period.source).toContain('ignored unparseable');
    });
});

describe('SurvivorWatchdog', () => {
    it('returns immediately once the group has drained', async () => {
        const scanner = new FakeScanner([
            new SurvivorScan([new SurvivingProcess(1, 'node worker')], null),
            new SurvivorScan([], null),
        ]);
        const watchdog = new SurvivorWatchdog(scanner, 1);
        const scan = await watchdog.waitForGroupToDrain(19424, Date.now() + 5000);
        expect(scan.survivors).toEqual([]);
        expect(scanner.calls).toBe(2);
    });

    it('gives up at the deadline and hands back the survivors', async () => {
        const scanner = new FakeScanner([new SurvivorScan([new SurvivingProcess(7, 'node stuck')], null)]);
        const watchdog = new SurvivorWatchdog(scanner, 1);
        const scan = await watchdog.waitForGroupToDrain(19424, Date.now() - 1);
        expect(scan.survivors).toHaveLength(1);
        expect(scanner.calls).toBe(1);
    });

    it('stops polling when ps is unavailable rather than spinning to the deadline', async () => {
        const scanner = new FakeScanner([new SurvivorScan([], 'ps could not be run: ENOENT')]);
        const watchdog = new SurvivorWatchdog(scanner, 1);
        const scan = await watchdog.waitForGroupToDrain(19424, Date.now() + 5000);
        expect(scan.scanError).toContain('ENOENT');
        expect(scanner.calls).toBe(1);
    });
});

describe('SurvivorReporter', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('writes the pids AND full command lines synchronously to the fd', () => {
        const file = path.join(os.tmpdir(), `wp-ci-survivors-${String(process.pid)}.log`);
        const fd = fs.openSync(file, 'w');
        new SurvivorReporter(fd).reportSurvivors(
            'nx affected --target=ci',
            new GracePeriod(1500000, 'default 25 minutes'),
            [new SurvivingProcess(20051, 'sh -c tsc -p tsconfig.json')],
        );
        fs.closeSync(fd);
        const output = fs.readFileSync(file, 'utf8');
        fs.rmSync(file, { force: true });
        expect(output).toContain('pid 20051  sh -c tsc -p tsconfig.json');
        expect(output).toContain('nx affected --target=ci');
        expect(output).toContain('default 25 minutes');
        expect(output).toContain('WP_CI_SURVIVOR_GRACE_MINUTES');
    });

    it('never throws when the fd cannot be written — a diagnostic must not replace the real failure', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => new SurvivorReporter(9999).reportScanUnavailable('step', 'no ps')).not.toThrow();
    });
});

class RecordingReporter extends SurvivorReporter {
    survivorReports = 0;
    unavailableReports = 0;

    override reportSurvivors(): void { this.survivorReports = this.survivorReports + 1; }
    override reportScanUnavailable(): void { this.unavailableReports = this.unavailableReports + 1; }
}

class RecordingKiller extends ProcessGroupKiller {
    killed: number[] = [];
    override kill(processGroupId: number): void { this.killed.push(processGroupId); }
}

function makeRunner(scans: SurvivorScan[], gracePeriodMillis: number): NxStepRunner {
    return new NxStepRunner(
        '/repo',
        new GracePeriod(gracePeriodMillis, 'test'),
        new SurvivorWatchdog(new FakeScanner(scans), 1),
        new RecordingReporter(),
        new RecordingKiller(),
    );
}

describe('NxStepRunner.settleStep', () => {
    it('uses an exit code distinct from an ordinary red build', () => {
        expect(NxStepRunner.SURVIVOR_TIMEOUT_EXIT_CODE).not.toBe(0);
        expect(NxStepRunner.SURVIVOR_TIMEOUT_EXIT_CODE).not.toBe(1);
    });

    it('passes the step exit code through when nothing survived', async () => {
        const reporter = new RecordingReporter();
        const killer = new RecordingKiller();
        const runner = new NxStepRunner(
            '/repo',
            new GracePeriod(5000, 'test'),
            new SurvivorWatchdog(new FakeScanner([new SurvivorScan([], null)]), 1),
            reporter,
            killer,
        );
        expect(await runner.settleStep(19424, 'step', 0)).toBe(0);
        expect(reporter.survivorReports).toBe(0);
        expect(killer.killed).toEqual([]);
    });

    it('FAILS LOUDLY and kills the group when survivors outlast the grace period', async () => {
        const reporter = new RecordingReporter();
        const killer = new RecordingKiller();
        const runner = new NxStepRunner(
            '/repo',
            new GracePeriod(0, 'test'),
            new SurvivorWatchdog(new FakeScanner([new SurvivorScan([new SurvivingProcess(20034, 'node worker')], null)]), 1),
            reporter,
            killer,
        );
        expect(await runner.settleStep(19424, 'step', 0)).toBe(NxStepRunner.SURVIVOR_TIMEOUT_EXIT_CODE);
        expect(reporter.survivorReports).toBe(1);
        expect(killer.killed).toEqual([19424]);
    });

    it('does not fail the build when ps itself is unavailable', async () => {
        const runner = makeRunner([new SurvivorScan([], 'ps could not be run: ENOENT')], 5000);
        expect(await runner.settleStep(19424, 'step', 0)).toBe(0);
    });
});
