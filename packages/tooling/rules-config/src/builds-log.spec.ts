import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    BuildsLog, BuildTicket, BUILDS_LOG_GENERATIONS, BUILD_START, MAX_BUILDS_LOG_BYTES, MAX_ROW_BYTES,
} from './builds-log';
import { DotWebpieces } from './state-dir';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A throwaway HOME. NOTHING in this suite may touch the real `~/.webpieces/builds.log` — it is the
 * developer's actual machine-wide ledger, and a spec that appended to it would both corrupt real data
 * and make its own assertions depend on whatever else the box happened to be building.
 */
function fakeHome(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-buildslog-')));
    dirs.push(dir);
    return dir;
}

function ledger(): BuildsLog {
    return new BuildsLog(new DotWebpieces());
}

function readLog(home: string): string[] {
    const file = new BuildsLog(new DotWebpieces()).logPath(home);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((line: string): boolean => line.trim() !== '');
}

/**
 * The pid of a process that has REALLY run and REALLY exited — death as a fact, not a mock.
 *
 * `spawnSync` runs the child to completion AND reaps it, so by the time it returns there is no zombie
 * left for `process.kill(pid, 0)` to find addressable. A killed-but-unreaped child would still answer
 * "alive", which is exactly the trap a hand-rolled version of this walks into.
 */
function deadPid(): number {
    const pid = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
    expect(pid).toBeGreaterThan(0);
    return pid ?? 0;
}

/** Write a START row by hand for a pid we control. The renderer is exercised elsewhere. */
function writeStartRow(home: string, id: string, pid: number): void {
    const file = new BuildsLog(new DotWebpieces()).logPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file,
        `${BUILD_START}\tid=${id}\tt=${new Date().toISOString()}\tms=${String(Date.now())}\t`
        + `by=build\trepo=/tmp/x\ttree=primary\tcwd=/tmp/x\tbranch=main\tpid=${String(pid)}\twp=\n`);
}

describe('BuildsLog — START/DONE pairing by uuid', () => {
    it('counts a START with no DONE as running, and stops counting it once finished', () => {
        const home = fakeHome();
        const log = ledger();
        const ticket = log.start('build', process.cwd(), home);
        expect(log.running(home).map((b: { id: string }): string => b.id)).toEqual([ticket.id]);
        log.finish(ticket, 0, home);
        expect(log.running(home)).toEqual([]);
    });

    it('pairs the RIGHT start with the right done when several are open at once', () => {
        const home = fakeHome();
        const log = ledger();
        const first = log.start('build', process.cwd(), home);
        const second = log.start('review', process.cwd(), home);
        const third = log.start('finish', process.cwd(), home);
        log.finish(second, 0, home);
        const ids = log.running(home).map((b: { id: string }): string => b.id).sort();
        expect(ids).toEqual([first.id, third.id].sort());
    });

    it('records a FAILING build as DONE-FAIL carrying its exit code, and stops counting it', () => {
        const home = fakeHome();
        const log = ledger();
        const ticket = log.start('build', process.cwd(), home);
        log.finish(ticket, 7, home);
        expect(log.running(home)).toEqual([]);
        const done = readLog(home).filter((line: string): boolean => line.startsWith('DONE-FAIL\t'));
        expect(done).toHaveLength(1);
        expect(done[0]).toContain('exit=7');
        expect(done[0]).toContain(`id=${ticket.id}`);
    });

    /**
     * The row-size invariant is what makes an unlocked append safe (a write at or under macOS `PIPE_BUF`
     * is indivisible), so it is a behaviour with a test, not a comment. Checked against a deliberately
     * absurd cwd so the clipping is what holds the line down, not the shortness of a temp path.
     */
    it('keeps every row under PIPE_BUF even with a pathologically long path', () => {
        const home = fakeHome();
        const deep = path.join(home, ...Array.from({ length: 8 }, (): string => 'a-very-long-directory-name'));
        fs.mkdirSync(deep, { recursive: true });
        const log = ledger();
        log.finish(log.start('build', deep, home), 0, home);
        for (const line of readLog(home)) {
            expect(Buffer.from(`${line}\n`, 'utf8').length).toBeLessThanOrEqual(MAX_ROW_BYTES);
        }
    });
});

describe('BuildsLog — a START whose process is DEAD is not running', () => {
    /**
     * THE REGRESSION THAT MATTERS MOST. A build killed with SIGKILL writes no DONE row. Without the pid
     * liveness test its START would count forever, the machine would sit permanently at the limit, and
     * every future `wp-build` would be refused with no way back short of deleting the file by hand.
     */
    it('drops an unpaired START whose pid has exited', () => {
        const home = fakeHome();
        writeStartRow(home, 'dead-build-uuid', deadPid());
        expect(ledger().running(home)).toEqual([]);
    });

    it('still counts an unpaired START whose pid IS alive', () => {
        const home = fakeHome();
        writeStartRow(home, 'live-build-uuid', process.pid);
        expect(ledger().running(home)).toHaveLength(1);
    });

    it('ignores a malformed row rather than throwing', () => {
        const home = fakeHome();
        const file = ledger().logPath(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'START\tnot even fields\n\nSTART\tid=\tpid=0\n');
        expect(ledger().running(home)).toEqual([]);
    });

    it('reports nothing, and never throws, when the ledger does not exist at all', () => {
        expect(ledger().running(fakeHome())).toEqual([]);
    });
});

describe('BuildsLog — rotation at 1 MB keeps exactly five generations', () => {
    it('shifts .4→.5 … .log→.1 and drops the oldest', () => {
        const home = fakeHome();
        const log = ledger();
        const file = log.logPath(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Every generation already present and individually identifiable, plus an oversized current log.
        for (let gen = 1; gen <= BUILDS_LOG_GENERATIONS; gen += 1) {
            fs.writeFileSync(log.rotatedPath(gen, home), `generation ${String(gen)}\n`);
        }
        fs.writeFileSync(file, 'x'.repeat(MAX_BUILDS_LOG_BYTES + 1));

        log.finish(log.start('build', process.cwd(), home), 0, home);

        // The current log was rotated to .1 and a fresh one holds only this build's two rows.
        expect(fs.statSync(log.rotatedPath(1, home)).size).toBeGreaterThan(MAX_BUILDS_LOG_BYTES);
        expect(readLog(home)).toHaveLength(2);
        // Each old generation moved up one, and the old .5 is gone rather than kept as a .6.
        for (let gen = 2; gen <= BUILDS_LOG_GENERATIONS; gen += 1) {
            expect(fs.readFileSync(log.rotatedPath(gen, home), 'utf8')).toBe(`generation ${String(gen - 1)}\n`);
        }
        expect(fs.existsSync(log.rotatedPath(BUILDS_LOG_GENERATIONS + 1, home))).toBe(false);
    });

    it('does NOT rotate a log that is still under the limit', () => {
        const home = fakeHome();
        const log = ledger();
        log.finish(log.start('build', process.cwd(), home), 0, home);
        expect(fs.existsSync(log.rotatedPath(1, home))).toBe(false);
        expect(readLog(home)).toHaveLength(2);
    });
});

describe('BuildsLog — concurrency', () => {
    /**
     * Many appenders at once, all landing intact. Rows are under `PIPE_BUF`, so even a writer that lost
     * the race for the lock cannot tear a line — which is the property that lets the append proceed
     * unlocked on timeout rather than failing the build it was logging.
     */
    it('lands every row intact when many builds start at the same instant', () => {
        const home = fakeHome();
        const log = ledger();
        const tickets: BuildTicket[] = [];
        for (let i = 0; i < 25; i += 1) tickets.push(log.start('build', process.cwd(), home));
        const lines = readLog(home);
        expect(lines).toHaveLength(25);
        for (const ticket of tickets) {
            expect(lines.filter((line: string): boolean => line.includes(`id=${ticket.id}`))).toHaveLength(1);
        }
        expect(log.running(home)).toHaveLength(25);
    });

    /**
     * A lock held by a LIVE process is not stolen — and the append happens anyway once the wait times
     * out. Logging may never fail a build, which is the whole reason the timeout path exists.
     */
    it('appends anyway, without throwing, when the lock is held by a live process', () => {
        const home = fakeHome();
        const log = ledger();
        const lock = log.lockPath(home);
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        // OUR pid: alive by definition, so the holder is never reclaimed as stale.
        fs.writeFileSync(lock, `{"pid":${String(process.pid)},"started":${String(Date.now())}}\n`);
        const ticket = log.start('build', process.cwd(), home);
        expect(readLog(home).some((line: string): boolean => line.includes(`id=${ticket.id}`))).toBe(true);
        // The foreign lock is left exactly where it was — we never held it, so we never release it.
        expect(fs.existsSync(lock)).toBe(true);
    });

    it('reclaims a lock left behind by a DEAD process', () => {
        const home = fakeHome();
        const log = ledger();
        const pid = deadPid();
        const lock = log.lockPath(home);
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        fs.writeFileSync(lock, `{"pid":${String(pid)},"started":${String(Date.now())}}\n`);
        const ticket = log.start('build', process.cwd(), home);
        expect(readLog(home).some((line: string): boolean => line.includes(`id=${ticket.id}`))).toBe(true);
        // Reclaimed AND released: a dead holder's lock must not survive the run that stepped over it.
        expect(fs.existsSync(lock)).toBe(false);
    });

    it('never throws when the ledger directory cannot be written', () => {
        const home = fakeHome();
        // A FILE where `.webpieces/` belongs: every mkdir/append below it fails with ENOTDIR.
        fs.writeFileSync(path.join(home, '.webpieces'), 'not a directory\n');
        const log = ledger();
        const ticket = log.start('build', process.cwd(), home);
        expect((): void => { log.finish(ticket, 0, home); }).not.toThrow();
        expect(log.running(home)).toEqual([]);
    });
});

describe('BuildsLog — executingVersion', () => {
    /**
     * Running from SOURCE (which is what this suite does, via tsconfig paths) has no enclosing
     * `node_modules/@webpieces/<pkg>`, and '' is the correct answer for that — not an error and not a
     * guess. The value is a log FIELD, so being unable to answer must degrade to an empty column.
     */
    it('answers a string, and never throws, wherever it is running from', () => {
        expect(typeof ledger().executingVersion()).toBe('string');
    });
});
