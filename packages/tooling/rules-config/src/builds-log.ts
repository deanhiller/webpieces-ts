import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { DotWebpieces } from './state-dir';
import { HOME_CONFIG_DIR } from './home-config';
import { toError } from './to-error';

/**
 * `~/.webpieces/builds.log` — the MACHINE-WIDE, append-only ledger of every build this box has started.
 *
 * ─── WHY THIS ONE FILE LIVES OUTSIDE THE REPO ─────────────────────────────────────────────────────────
 * `no-machine-global-state.spec.ts` records the standing rule: webpieces writes state under
 * `{repo}/.webpieces` and nowhere else. This is the ONE carve-out, and the argument is written out in
 * `decisions/0006-the-build-ledger-is-machine-global.md`. In short:
 *
 *   • The FACT is machine-scoped. "How many builds are burning this box's CPU right now" is not a
 *     property of any repo; it is a property of the machine. A per-repo ledger cannot answer it — every
 *     linked worktree has its OWN `.webpieces/`, so it would be blind to the sibling worktree it is
 *     actually contending with, never mind the four other repos on the disk.
 *   • It is NOT A CACHE. The retired `PrBodyStore` that the no-machine-global rule was written for was a
 *     local copy of a fact GitHub owned, so it could be stale, missing, or on the wrong computer. There
 *     is no remote copy of this. The file IS the fact.
 *   • Its key is an ABSOLUTE LOCAL PATH, which is stable precisely because it never leaves the machine —
 *     the instability that killed `PrBodyStore`'s `<host>/<owner>/<repo>` key cannot arise here.
 *
 * ─── WHY IT IS SAFE TO WRITE CONCURRENTLY ─────────────────────────────────────────────────────────────
 * Rows are deliberately kept under `MAX_ROW_BYTES` (512, macOS `PIPE_BUF`). A single `O_APPEND`
 * `write(2)` at or below that size is indivisible, so two builds appending at the same instant cannot
 * interleave halves of a line. The lock is therefore belt-and-braces for the APPEND and genuinely
 * load-bearing for ROTATION, where a rename-and-reopen really does race.
 *
 * ─── IT MAY NEVER FAIL A BUILD ────────────────────────────────────────────────────────────────────────
 * Every method here is best-effort and swallows its own errors. A build must never die because a log
 * file was busy, unwritable, or on a full disk. Lock acquisition retries and then gives up and appends
 * anyway — which the row-size invariant above makes safe.
 */
export const BUILDS_LOG_FILE = 'builds.log';
export const BUILDS_LOCK_FILE = 'builds.log.lock';

/** START, and the two terminal kinds. `DONE-` is the greppable prefix that pairs with a START. */
export const BUILD_START = 'START';
export const BUILD_DONE_SUCCESS = 'DONE-SUCCESS';
export const BUILD_DONE_FAIL = 'DONE-FAIL';

/** Rotate at 1 MB, keeping five generations (`.1` … `.5`); the old `.5` is dropped. */
export const MAX_BUILDS_LOG_BYTES = 1024 * 1024;
export const BUILDS_LOG_GENERATIONS = 5;

/**
 * macOS `PIPE_BUF`. A row at or under this size is written by ONE indivisible `write(2)`, which is what
 * makes a lost lock a non-event rather than a corrupted file. Long paths are clipped to hold the line
 * under it — see `clip`.
 */
export const MAX_ROW_BYTES = 512;

/** How long a build may hold the lock before another writer stops waiting and appends anyway. */
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 2000;

/**
 * The handle a START row hands back, and the ONLY thing `finish()` accepts. Data-only (a class, per
 * CLAUDE.md), carrying exactly the fields the DONE row needs to pair itself with its START: the uuid,
 * the caller, the repo, and when it began (so `took=` is computed from one clock, not two).
 */
export class BuildTicket {
    id: string;
    by: string;
    repo: string;
    startedMs: number;

    constructor(id: string, by: string, repo: string, startedMs: number) {
        this.id = id;
        this.by = by;
        this.repo = repo;
        this.startedMs = startedMs;
    }
}

/**
 * One build that is STILL RUNNING — a START row with no matching `DONE-`, whose pid is still alive.
 * Data-only. This is what the refusal message renders, so it carries the three things a reader needs to
 * recognise the build in question: where it is, which tree, and how old it is.
 */
export class RunningBuild {
    id: string;
    by: string;
    repo: string;
    tree: string;
    cwd: string;
    branch: string;
    pid: number;
    startedMs: number;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        id: string, by: string, repo: string, tree: string,
        cwd: string, branch: string, pid: number, startedMs: number,
    ) {
        this.id = id;
        this.by = by;
        this.repo = repo;
        this.tree = tree;
        this.cwd = cwd;
        this.branch = branch;
        this.pid = pid;
        this.startedMs = startedMs;
    }
}

/**
 * The ledger. See the file docblock for why it is machine-global and why every operation swallows its
 * own errors.
 *
 * `homeDir` is a parameter on every public method, defaulted to `os.homedir()`, for exactly the reason
 * `HomeConfigService.configPath` takes one: a spec must be able to exercise the real code against a temp
 * directory and must never touch the developer's actual `~/.webpieces`.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildsLog {
    constructor(private readonly dotDir: DotWebpieces) {}

    /** `~/.webpieces/builds.log`. */
    logPath(homeDir: string = os.homedir()): string {
        return path.join(homeDir, HOME_CONFIG_DIR, BUILDS_LOG_FILE);
    }

    /** `~/.webpieces/builds.log.lock` — `{"pid":N,"started":<epochMs>}`. */
    lockPath(homeDir: string = os.homedir()): string {
        return path.join(homeDir, HOME_CONFIG_DIR, BUILDS_LOCK_FILE);
    }

    /** `~/.webpieces/builds.log.<n>` — generation `n`, 1 being the most recent. */
    rotatedPath(generation: number, homeDir: string = os.homedir()): string {
        return `${this.logPath(homeDir)}.${String(generation)}`;
    }

    /**
     * Record that a build is starting, and hand back the ticket its DONE row will need.
     *
     * `by` is the CALLER — `BuildGateOptions.stage`, i.e. `build` | `review` | `finish`. There is no
     * second "caller" concept anywhere: the stage id already is one, and a second spelling of it would
     * be the shim CLAUDE.md rejects.
     *
     * Returns a ticket even when the append failed. A build whose START row never landed still has to be
     * able to call `finish()`; the alternative is a nullable return that every call site must branch on
     * for a logging failure that is, by policy, not an error.
     */
    start(by: string, startDir: string, homeDir: string = os.homedir()): BuildTicket {
        const ticket = new BuildTicket(
            crypto.randomUUID(), by, this.dotDir.primaryRoot(startDir), Date.now());
        this.append(this.startRow(ticket, startDir), homeDir);
        return ticket;
    }

    /**
     * Record that the build behind `ticket` has ended. `exitCode` 0 writes `DONE-SUCCESS`; anything else
     * writes `DONE-FAIL` carrying the code, so `grep DONE-FAIL` lists every red build on the machine.
     */
    finish(ticket: BuildTicket, exitCode: number, homeDir: string = os.homedir()): void {
        this.append(this.doneRow(ticket, exitCode), homeDir);
    }

    /**
     * Every build that is still live: a `START` with no matching `DONE-` row, whose pid is still alive.
     *
     * The pid filter is not an optimisation, it is what keeps the ledger from wedging the machine. A
     * build killed with SIGKILL — an agent cancelled mid-run, a terminal closed — writes no DONE row, so
     * without the liveness test its START would count forever and the fourth build would be refused for
     * the rest of the machine's life. The uuid answers "which build"; the pid answers "is it still real".
     *
     * Only the CURRENT generation is read. A rotated-away START is by definition at least 1 MB of rows
     * old and is not a build anyone is contending with.
     */
    running(homeDir: string = os.homedir()): RunningBuild[] {
        const lines = this.readLines(this.logPath(homeDir));
        const done = new Set<string>();
        for (const line of lines) {
            if (line.startsWith(`${BUILD_DONE_SUCCESS}\t`) || line.startsWith(`${BUILD_DONE_FAIL}\t`)) {
                done.add(this.field(line, 'id'));
            }
        }
        const live: RunningBuild[] = [];
        for (const line of lines) {
            if (!line.startsWith(`${BUILD_START}\t`)) continue;
            const build = this.toRunningBuild(line);
            if (build === null || done.has(build.id)) continue;
            if (!this.isAlive(build.pid)) continue;
            live.push(build);
        }
        return live;
    }

    /**
     * The `@webpieces` release ACTUALLY EXECUTING — found by walking UP from this module's own directory
     * to the nearest enclosing `node_modules/@webpieces/<pkg>/package.json`. `''` when this code is
     * running from source rather than from an installed package (which is the state in this repo's own
     * specs, and a perfectly ordinary answer).
     *
     * ─── WHY THIS IS NOT `WebpiecesVersions.readInstalled(root)` ──────────────────────────────────────
     * They answer DIFFERENT QUESTIONS and merging them would break the older one. `readInstalled` joins
     * `<root>/node_modules/@webpieces/...` at a FIXED tree root ON PURPOSE: its whole job is to detect
     * DRIFT between what a tree PINS and what some other tree pins, and a walk-up would silently resolve
     * a worktree with no install of its own to the primary clone's copy — hiding exactly the skew that
     * guard exists to catch. This question is the opposite one: "whichever copy is running, name it", and
     * for that the walk-up is the only correct answer. Do not fold them together.
     */
    executingVersion(): string {
        let dir = __dirname;
        for (let hops = 0; hops < 40; hops += 1) {
            const version = this.versionOfEnclosingPackage(dir);
            if (version !== '') return version;
            const parent = path.dirname(dir);
            if (parent === dir) return '';
            dir = parent;
        }
        return '';
    }

    // `<dir>` is `node_modules/@webpieces/<pkg>/...`? Then that package's version, else ''.
    private versionOfEnclosingPackage(dir: string): string {
        const parent = path.dirname(dir);
        const grandparent = path.dirname(parent);
        if (path.basename(parent) !== '@webpieces' || path.basename(grandparent) !== 'node_modules') return '';
        const text = this.readTextOrEmpty(path.join(dir, 'package.json'));
        const match = /"version"\s*:\s*"([^"]+)"/.exec(text);
        return match === null ? '' : match[1];
    }

    // ─── ROW RENDERING ────────────────────────────────────────────────────────────────────────────────

    private startRow(ticket: BuildTicket, startDir: string): string {
        return [
            BUILD_START,
            `id=${ticket.id}`,
            `t=${new Date(ticket.startedMs).toISOString()}`,
            `ms=${String(ticket.startedMs)}`,
            `by=${ticket.by}`,
            `repo=${this.clip(ticket.repo)}`,
            `tree=${this.dotDir.worktreeName(startDir) || 'primary'}`,
            `cwd=${this.clip(startDir)}`,
            `branch=${this.gitBranch(startDir)}`,
            `pid=${String(process.pid)}`,
            `wp=${this.executingVersion()}`,
        ].join('\t');
    }

    private doneRow(ticket: BuildTicket, exitCode: number): string {
        const now = Date.now();
        const fields = [
            exitCode === 0 ? BUILD_DONE_SUCCESS : BUILD_DONE_FAIL,
            `id=${ticket.id}`,
            `t=${new Date(now).toISOString()}`,
            `ms=${String(now)}`,
            `by=${ticket.by}`,
            `repo=${this.clip(ticket.repo)}`,
            `took=${String(now - ticket.startedMs)}`,
        ];
        if (exitCode !== 0) fields.push(`exit=${String(exitCode)}`);
        fields.push(`pid=${String(process.pid)}`);
        return fields.join('\t');
    }

    /**
     * Hold a long path down to `max` characters by keeping its TAIL, which is the half that identifies
     * the tree; a clipped value is marked with a leading `…` so nobody mistakes it for a real path.
     *
     * This is what keeps a row under `MAX_ROW_BYTES` — see the file docblock. `append` re-checks the
     * assembled line as a backstop, because three clipped fields plus a long branch name can still add up.
     */
    private clip(value: string, max = 120): string {
        const oneLine = value.replace(/[\t\n\r]/g, ' ');
        return oneLine.length <= max ? oneLine : `…${oneLine.slice(oneLine.length - max)}`;
    }

    // ─── ROW PARSING ──────────────────────────────────────────────────────────────────────────────────

    /** The value of `<name>=` on a TSV row, or '' when the row does not carry it. */
    private field(line: string, name: string): string {
        for (const part of line.split('\t')) {
            if (part.startsWith(`${name}=`)) return part.slice(name.length + 1);
        }
        return '';
    }

    // A START row as a RunningBuild, or null when it is missing the two fields that make it usable.
    private toRunningBuild(line: string): RunningBuild | null {
        const id = this.field(line, 'id');
        const pid = Number.parseInt(this.field(line, 'pid'), 10);
        if (id === '' || !Number.isInteger(pid) || pid <= 0) return null;
        const startedMs = Number.parseInt(this.field(line, 'ms'), 10);
        return new RunningBuild(
            id, this.field(line, 'by'), this.field(line, 'repo'), this.field(line, 'tree'),
            this.field(line, 'cwd'), this.field(line, 'branch'), pid,
            Number.isInteger(startedMs) ? startedMs : 0,
        );
    }

    /**
     * Is `pid` still addressable? `process.kill(pid, 0)` sends no signal — it only asks the kernel. ESRCH
     * is the ONE answer that proves death; EPERM proves the opposite (it exists, it is somebody else's).
     * Pid reuse is an accepted imprecision here: being wrong in the "still running" direction costs
     * one extra refusal, being wrong the other way lets a fourth build start.
     *
     * WHY A PID IS MEANINGFUL HERE AND WAS NOT FOR AGENT WORKTREE LOCKS. Every row in this ledger is
     * written BY the process it names — one real OS process per build — so its pid identifies it.
     * A Claude Code subagent is not a process at all: every agent in a session records the SAME pid,
     * the session's, which is why that check was deleted rather than shared (see
     * harness-agent-activity.ts). Do not generalise this one back out to anything but a real process.
     */
    private isAlive(pid: number): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            process.kill(pid, 0);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
    }

    // ─── APPEND, LOCK, ROTATE ─────────────────────────────────────────────────────────────────────────

    /**
     * Append one row, best-effort. Takes the lock so rotation cannot race, and appends ANYWAY when the
     * lock cannot be had within `LOCK_TIMEOUT_MS` — the row is under `PIPE_BUF`, so an unlocked
     * `O_APPEND` write is still indivisible, and a build must never die because a log file was busy.
     */
    private append(row: string, homeDir: string): void {
        const line = `${this.truncateToRowLimit(row)}\n`;
        const held = this.tryAcquireLock(homeDir);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            this.ensureDir(this.logPath(homeDir));
            if (held) this.rotateIfLarge(homeDir);
            fs.appendFileSync(this.logPath(homeDir), line);
        } catch (err: unknown) {
            const error = toError(err);
            void error;  // logging may never fail a build — see the file docblock
        } finally {
            if (held) this.releaseLock(homeDir);
        }
    }

    // The backstop for the PIPE_BUF invariant, measured in BYTES rather than characters because a path
    // may hold multi-byte characters. Truncating a row loses fields off the end, which is strictly better
    // than a torn line that breaks every row after it.
    private truncateToRowLimit(row: string): string {
        const bytes = Buffer.from(row, 'utf8');
        // -1 for the newline `append` adds.
        if (bytes.length <= MAX_ROW_BYTES - 1) return row;
        return bytes.subarray(0, MAX_ROW_BYTES - 1).toString('utf8');
    }

    /**
     * Take the ledger lock, retrying every `LOCK_RETRY_MS` until `LOCK_TIMEOUT_MS`. False means "carry on
     * without it" — never an error, and never a reason to skip the append.
     *
     * The mechanism is `MainSyncStatusService.tryAcquireMainSyncLock`'s, proven and deliberately copied
     * rather than re-invented: an `wx` (O_CREAT|O_EXCL) create so exactly one of N racers wins, a payload
     * carrying pid + started so a dead holder is identifiable, stale reclaim gated on pid liveness, and a
     * re-read afterwards to confirm the entry on disk is OURS (a simultaneous reclaimer could have
     * unlinked ours and written its own between the two calls).
     */
    private tryAcquireLock(homeDir: string): boolean {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        this.ensureDir(this.lockPath(homeDir));
        // Rendered rather than JSON.stringify'd off an anonymous object — two fields, both numbers, and
        // the file's whole contract is `{"pid":N,"started":M}`.
        const payload = `{"pid":${String(process.pid)},"started":${String(Date.now())}}\n`;
        for (;;) {
            if (this.createExclusive(this.lockPath(homeDir), payload)) return true;
            if (!this.isHolderAlive(homeDir)) {
                this.unlinkQuietly(this.lockPath(homeDir));
                if (this.createExclusive(this.lockPath(homeDir), payload) && this.holderIsUs(homeDir)) return true;
            }
            if (Date.now() >= deadline) return false;
            this.sleep(LOCK_RETRY_MS);
        }
    }

    private releaseLock(homeDir: string): void {
        if (!this.holderIsUs(homeDir)) return;
        this.unlinkQuietly(this.lockPath(homeDir));
    }

    // O_CREAT|O_EXCL write: true when THIS call created the file, false when it already existed.
    private createExclusive(file: string, payload: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.writeFileSync(file, payload, { flag: 'wx' });
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    // The pid recorded in the lock file, or 0 when there is no readable lock.
    private lockHolderPid(homeDir: string): number {
        const text = this.readTextOrEmpty(this.lockPath(homeDir));
        if (text === '') return 0;
        const match = /"pid"\s*:\s*(\d+)/.exec(text);
        return match === null ? 0 : Number.parseInt(match[1], 10);
    }

    // An unreadable or pid-less lock file counts as DEAD: it is a corpse from a crashed writer, and
    // leaving it forever would mean every future append silently skips rotation.
    private isHolderAlive(homeDir: string): boolean {
        const pid = this.lockHolderPid(homeDir);
        return pid > 0 && this.isAlive(pid);
    }

    private holderIsUs(homeDir: string): boolean {
        return this.lockHolderPid(homeDir) === process.pid;
    }

    /**
     * `.4→.5, .3→.4, … .log→.1`, dropping the old `.5`. Runs INSIDE the lock, which is the one place the
     * lock is genuinely load-bearing: a rename-and-reopen really does race, and a writer that opened the
     * old inode mid-shift would append into a file nobody reads again.
     */
    private rotateIfLarge(homeDir: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!fs.existsSync(this.logPath(homeDir))) return;
            if (fs.statSync(this.logPath(homeDir)).size < MAX_BUILDS_LOG_BYTES) return;
            this.unlinkQuietly(this.rotatedPath(BUILDS_LOG_GENERATIONS, homeDir));
            for (let gen = BUILDS_LOG_GENERATIONS - 1; gen >= 1; gen -= 1) {
                this.renameQuietly(this.rotatedPath(gen, homeDir), this.rotatedPath(gen + 1, homeDir));
            }
            this.renameQuietly(this.logPath(homeDir), this.rotatedPath(1, homeDir));
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    // ─── FILESYSTEM PRIMITIVES, ALL SWALLOWING ────────────────────────────────────────────────────────

    private ensureDir(file: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    private unlinkQuietly(file: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    private renameQuietly(from: string, to: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (fs.existsSync(from)) fs.renameSync(from, to);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    private readTextOrEmpty(file: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }

    private readLines(file: string): string[] {
        const text = this.readTextOrEmpty(file);
        if (text === '') return [];
        return text.split('\n').filter((line: string): boolean => line.trim() !== '');
    }

    // A blocking sleep, because the lock retry sits on a synchronous append path that must not become
    // async — `finish()` is called from a `finally` and an async logger there could outlive the process.
    private sleep(ms: number): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    // The checked-out branch in `startDir`, or '' when git cannot say. spawnSync does not throw on a
    // non-zero exit, so "not a repo" arrives as a status, not an exception.
    private gitBranch(startDir: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
                { cwd: startDir, encoding: 'utf8' });
            if (result.status !== 0 || typeof result.stdout !== 'string') return '';
            return result.stdout.trim();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }
}
