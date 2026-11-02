import * as fs from 'fs';
import * as path from 'path';
import { dotWebpieces, LOGS_STATE_DIR } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';

// ─── Why this class exists ─────────────────────────────────────────────────────────────────────────────
// TWO things in this package write a big blob of output to a file and hand the caller a one-line pointer
// instead of the blob: the BUILD (BuildGateLog) and the STAGE CONSOLE (StageOutputLog). They are different
// subjects — one spawns a child and heartbeats, the other intercepts this process's own stdout — but the
// FILE half is identical: where the file lands, how the previous run is kept, and what the pointer at it
// reads like.
//
// That half lives here, once. Cloning it would have given the two logs two answers to "where is it?" and
// two rotation policies, and the whole value of the pointer is that a reader recognises it instantly and
// can `grep` it without first working out which subsystem wrote it.
//
// ─── WHERE the files land, and why that shape ──────────────────────────────────────────────────────────
// Through `dotWebpieces.aiFacing()` — never `path.join(repoRoot, '.webpieces')` — into ONE directory,
// `<tree>/.webpieces/logs/`, where `<tree>` is the checkout the command ran in: the primary clone, or a
// LINKED WORKTREE's own root (issue #1393). So:
//   • N agents in N worktrees never write one another's log, by construction rather than by naming;
//   • the path a command prints is INSIDE the tree the agent is working in. An agent whose reads are
//     scoped to its worktree (auto mode's classifier, a sandbox, Codex's workspace-write) can always
//     read it. These logs used to live under `<primary>/.webpieces/worktrees/<name>/`, outside the
//     worktree, and three unattended runs died at a refused read of exactly that path;
//   • it self-limits: the logs die with the worktree, and `cleanTmp` already prunes the AI-facing root.
//     Nothing here needs a retention policy of its own.

/** The suffix of the ONE previous generation kept beside a log. */
const BACKUP_SUFFIX = '.bak';

/**
 * The file mechanics shared by every captured log in the PR gate: WHERE it goes, keeping the previous
 * run, the pointer the caller prints instead of the output, and the failure tail.
 *
 * It knows nothing about builds, stages or console interception — its callers own all of that. Singleton
 * because it is pure behaviour over paths; it holds no state.
 */
@injectable(bindingScopeValues.Singleton)
export class GateLogFile {
    /**
     * `<tree>/.webpieces/logs/<name>` — the ONE directory every log a command points its caller at
     * lives in, inside the checkout the command ran in. Creates the directory.
     */
    logsPath(repoRoot: string, name: string): string {
        return this.ensureDir(dotWebpieces.aiFacingFile(repoRoot, LOGS_STATE_DIR, name));
    }

    /** Where the PREVIOUS run of `logPath` is kept — always `<logPath>.bak`. */
    backupPathFor(logPath: string): string {
        return `${logPath}${BACKUP_SUFFIX}`;
    }

    /**
     * Move an existing log aside to `<log>.bak`, overwriting any previous backup, so the last TWO runs
     * are always on disk. A missing log is the normal first-run state and is not an error.
     *
     * ONE generation, everywhere: a re-run at the same commit does not truncate away the run before it,
     * and a reader never has to work out which of N dated files is the one they want.
     */
    rotate(logPath: string): void {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        if (!fs.existsSync(logPath)) return;
        fs.rmSync(this.backupPathFor(logPath), { force: true });
        fs.renameSync(logPath, this.backupPathFor(logPath));
    }

    /**
     * The line a command prints BEFORE it does any work: the same `FullLog : <path>` the closing pointer
     * repeats (issue #1393). A caller that backgrounds the command, or whose harness captures its console
     * into a file of its own, then knows where to read from the first line on — it never has to reach
     * for the harness's capture file, which an unattended agent may be refused.
     */
    startLine(logPath: string): string {
        return `FullLog : ${logPath}\n`;
    }

    /**
     * The two lines that name a log — identical on success and on failure, so there is exactly one shape
     * to recognise.
     *
     * The backup line states what is TRUE RIGHT NOW: on the very first run in a tree there is no `.bak`
     * yet, and pointing a reader at a file that does not exist is the small lie that costs a wasted `cat`.
     */
    pointer(logPath: string): string {
        const name = path.basename(logPath);
        const backedUp = fs.existsSync(this.backupPathFor(logPath))
            ? `(${name} is backed up to ${name}${BACKUP_SUFFIX} every run so you have the last 2 runs of logs)`
            : `(the previous ${name} is kept as ${name}${BACKUP_SUFFIX} on every run — this is the first, so there is none yet)`;
        return `FullLog : ${logPath}\n${backedUp}\n`;
    }

    /**
     * The path as a progress line should show it: relative to the repo when it sits inside it (it always
     * does now that logs live in the tree's own `.webpieces/logs/`), absolute otherwise.
     */
    displayPath(repoRoot: string, logPath: string): string {
        const relative = path.relative(repoRoot, logPath);
        return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? logPath : relative;
    }

    /**
     * The log's last `lines` lines, indented, or a plain statement of why there are none.
     *
     * A read that fails is REPORTED, never allowed to throw: this renders a message for something that
     * has ALREADY failed, so an I/O error escaping here would replace the real failure with the
     * renderer's own — the caller would lose the actual error and be handed a filesystem error instead.
     * The full log is still named on the line above, so nothing is hidden by degrading to one line.
     */
    tail(logPath: string, lines: number): string {
        if (!fs.existsSync(logPath)) return `    (no log file at ${logPath})\n`;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: see above, the failure renderer may not
        // replace the caller's failure with its own.
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const all = fs.readFileSync(logPath, 'utf8').split('\n').filter((l: string): boolean => l !== '');
            if (all.length === 0) return '    (the log is empty)\n';
            return all.slice(-lines).map((l: string): string => `    ${l}\n`).join('');
        } catch (err: unknown) {
            const error = toError(err);
            return `    (could not read ${logPath}: ${error.message})\n`;
        }
    }

    /** How many lines the log holds right now. A log that does not exist yet is zero lines, not an error. */
    lineCount(logPath: string): number {
        if (!fs.existsSync(logPath)) return 0;
        const body = fs.readFileSync(logPath, 'utf8');
        if (body === '') return 0;
        return body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
    }

    private ensureDir(file: string): string {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return file;
    }
}
