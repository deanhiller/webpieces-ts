import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { dotWebpieces, readMainSyncStatus, MainSyncStatus, RepoRootFinder, claudeEnv } from '@webpieces/rules-config';
import { L1_LOCATION_STREAM, L2_DECISIONS_STREAM, CALLS_STREAM } from './log-streams';

import { L0_FAULT_NONE } from './l0-fault-codes';
import { toError } from './to-error';
import { logStream } from './log-stream';

// The SYNC decision log — what the synchronous hook DID on each invocation and WHY. Its companion is
// the ASYNC log (guard-async-work.log, written by the detached refresher in main-sync-log.ts). This
// one records EVERY guard decision — allow, block, config-bypass, and the fail-open cases — and CITES
// the async-written cache snapshot (`cache` field) that drove the decision, so a wrong allow/block is
// traceable to a stale or missing async write. Writes to `.webpieces/logs/<stream>guard-sync-decisions.log`
// (see LOGS_STATE_DIR: every webpieces log lives under `logs/`, never beside `hooks/`'s non-log state).
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded (mirrors rejection-log)
const MAX_TARGET_LEN = 160;

/**
 * THE ACTION CODEBOOK, as a type. These are the five actions GUARD_MATRIX.md numbers 1-5, and they
 * are the vocabulary EVERY layer reports in — so one grep spans L-1, L0, L1 and L2.
 *
 * The three distinctions this exists to make, none of which `'ALLOW' | 'BLOCK'` could:
 *
 *   ALLOW            no objection — the call was HANDED DOWN to the next layer. A layer saying ALLOW
 *                    is NOT saying the call ran: the layer below it, or the PARALLEL L-1 hook, may
 *                    still deny. This is L1's `ACT_DOWN`.
 *   ALLOW_EXEMPT     out of scope by construction — allowed, and evaluation STOPS here. L1's
 *                    `ACT_EXEMPT`.
 *   ALLOW_FAIL_OPEN  state could not be established, so nothing was judged. Keeping this distinct
 *                    from ALLOW is the entire point of the type: a fail-open allow and a real allow
 *                    that look identical make it impossible to tell whether the guards are protecting
 *                    anything or quietly abstaining. It used to be a `' (fail-open)'` SUBSTRING on the
 *                    reason field, which is exactly why the abstentions were never countable.
 *   BLOCK_AI_CURE    blocked, and the printed cure is a command the AI can run itself.
 *   BLOCK_HUMAN      blocked, and it needs a human decision — or a delegation (spawn a subagent) that
 *                    the blocked agent cannot perform for itself.
 *
 * Hard cut, per CLAUDE.md: `'BLOCK'` is GONE rather than aliased, so every construction site fails to
 * compile and has to say which kind of block it is. Before, that question had exactly one wrong
 * answer available — silence.
 */
export type Verdict = 'ALLOW' | 'ALLOW_EXEMPT' | 'ALLOW_FAIL_OPEN' | 'BLOCK_AI_CURE' | 'BLOCK_HUMAN';

/**
 * WHICH ROW of WHICH layer's decision table produced this line. Data-only → a class, per CLAUDE.md.
 *
 * `row` is the row NUMBER from the layer's row array (`L1_ROWS[i].num`, `LMINUS1_ROWS[i].num`) — the
 * same number the generated doc prints, because the doc is rendered from that same array. So a log
 * line joins to its matrix row BY NUMBER, and checking observed behaviour against the documented use
 * cases becomes a lookup rather than an investigation. `'-'` for a layer with no row array yet (L2).
 */
export class MatrixRef {
    constructor(readonly layer: string, readonly row: string) {}
}

/** For the sites with no row array to cite yet — L2's guards, and the L0 fault stamps. */
export const MATRIX_NONE = new MatrixRef('-', '-');

// Data-only record of one guard decision (per CLAUDE.md: classes for data, not object literals).
// `cache` summarizes the async-written main-sync-status.json that drove a feature-branch-guard
// decision (branch/merged/conflict/fork + the cache timestamp), or '-' when no cache was consulted
// (bash guards, on-main, config-bypass).
export class GuardDecision {
    rule: string;
    tool: string;
    target: string; // file path (file guards) or the bash command (bash guards)
    branch: string;
    verdict: Verdict;
    reason: string;
    cache: string;
    /**
     * The L0 fault this decision IS, in the codebook's letter (core/l0-fault-codes.ts), or `-` for an
     * ordinary rule decision. The `sh` shim has always stamped `fault=` on its own stream; the three
     * JS-side faults (S/C/Y) reached this one with no label at all, so `grep fault=S` found nothing
     * even while an S storm was blocking every call.
     */
    fault: string;
    /** Which layer + row decided this. See MatrixRef — it is what joins a log line to the doc. */
    matrix: MatrixRef;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(rule: string, tool: string, target: string, branch: string, verdict: Verdict, reason: string, cache: string = '-', fault: string = L0_FAULT_NONE, matrix: MatrixRef = MATRIX_NONE) {
        this.rule = rule;
        this.tool = tool;
        this.target = target;
        this.branch = branch;
        this.verdict = verdict;
        this.reason = reason;
        this.cache = cache;
        this.fault = fault;
        this.matrix = matrix;
    }
}

/**
 * Append one tab-separated line per decision to `.webpieces/logs/<stream>guard-sync-decisions.log`,
 * where <stream> is LogStream's `<sessionId>-<agentId|coordinator>-<hook>-` prefix (empty when the
 * caller never identified renders as `unknown-coordinator-hook-` — there is no un-prefixed name).
 * `root` is
 * the repo/workspace root that holds `.webpieces` (callers pass workspaceRoot, or a
 * RepoRootFinder-resolved root at the pre-load config-bypass site — never a raw cwd, so a bypass
 * logged from a subdir never scatters a stray `.webpieces`). Swallows all errors — logging must never
 * block or fail a hook.
 */
// webpieces-disable no-function-outside-class -- the module-scope writer this log has always been, beside branchForLog/oneLine/rotateLogFile; it must stay callable from a tree too broken to build a DI container
export function logGuardDecision(root: string, decision: GuardDecision): void {
    appendDecision(root, L2_DECISIONS_STREAM, decision);
}

/**
 * The L1 stream — `.webpieces/logs/L1-location/<writer>.log`.
 *
 * L1 had NO stream. Its three blocking paths wrote into L2's file under an implementation name
 * (`force-to-root`, `coordinator-in-worktree`, `cd-must-be-first`), and its NON-blocking outcomes —
 * the exempt row and the three hand-down rows — wrote nothing at all. So "L1 had no objection" was
 * unobservable, and "show me every L1 decision" had no answer: L1 existed in the trail only as the
 * `root=` / `projectDir=` / `tree=` columns stapled onto somebody else's line.
 *
 * A SIBLING rather than a `base` parameter on logGuardDecision, deliberately: that signature is what
 * the process-wide `logStream` singleton exists to keep unchanged (see LogStream's docblock), and
 * `INVOCATION_LOG_FILE` already establishes the pattern of a second stream owning its own name in
 * this same module.
 */
// webpieces-disable no-function-outside-class -- sibling of logGuardDecision, same module-scope writer shape and same reason
export function logL1Decision(root: string, decision: GuardDecision): void {
    appendDecision(root, L1_LOCATION_STREAM, decision);
}

// The one appender both streams share. `streamDir` is the LAYER; the writer key inside it is
// logStream's session/agent/hook, which is what keeps one writer per file.
// webpieces-disable no-function-outside-class -- the shared body of the two module-scope writers above
function appendDecision(root: string, streamDir: string, decision: GuardDecision): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const timestamp = new Date().toISOString();
        // LOCAL scope: a guard decision belongs to the tree it judged. WHO made the call is answered
        // by the filename, which logStream names with session/agent/hook.
        const logsDir = dotWebpieces.logsFile(root, streamDir);
        fs.mkdirSync(logsDir, { recursive: true });

        const logPath = path.join(logsDir, logStream.writerFile('.log'));
        rotateLogFile(logPath, path.join(logsDir, logStream.writerFile('.1.log')));

        const line = [
            `[${timestamp}]`,
            decision.verdict,
            decision.tool,
            oneLine(decision.target),
            decision.branch,
            decision.rule,
            oneLine(decision.reason),
            oneLine(decision.cache),
            // WHICH ROW of WHICH table decided this. The directory already carries the layer, but a
            // line quoted out of its file must still say what judged it — and `row=` is the join key
            // to the generated doc, which is the point of the whole exercise.
            `layer=${decision.matrix.layer}`,
            `row=${decision.matrix.row}`,
            // The tree this decision was actually made against, and what Claude Code told the hook the
            // project was. Appended (never reordered) for the same reason as on the invocation line —
            // see ClaudeEnv: when these two disagree, that disagreement is the bug.
            `root=${root}`,
            `projectDir=${claudeEnv.projectDirForLog()}`,
            // git's name for that tree — `primary`, else the worktree name. Same literal and same
            // derivation as the L0 shim log's `tree=` (shim-audit-log.ts), so one grep spans both
            // streams: L0 carries tree without projectDir, L1 now carries both.
            `tree=${dotWebpieces.worktreeName(root) || 'primary'}`,
            // APPEND-ONLY, same spelling as the invocation line and the L0 shim log: which L0 fault
            // this was, or `-`.
            `fault=${decision.fault}`,
        ].join('\t') + '\n';
        fs.appendFileSync(logPath, line);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
}

/**
 * What the guard SAW on one invocation, captured up front and held until the outcome is known.
 * Data-only (per CLAUDE.md: classes for data, explicit construction).
 */
export class GuardInvocation {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        public readonly root: string,
        public readonly timestamp: string,
        public readonly tool: string,
        public readonly target: string,
        public readonly branch: string,
        public readonly sync: string,
        public readonly projectDir: string,
    ) {}
}

/**
 * The per-INVOCATION stream — `.webpieces/logs/<stream>guard-invocations.log` (see LogStream for the
 * `<stream>` prefix), one line for EVERY guards-hook
 * call (allow or block, bash or file), unlike guard-sync-decisions.log which records only the calls a
 * rule actually judged. It captures the tool, the command/file, the live git branch, the async-written
 * main-sync-status.json snapshot (branch / merged / fork-point / conflict), and — since this class
 * replaced a bare log-and-forget function — HOW THE CALL ENDED.
 *
 * WHY IT IS TWO CALLS. The line used to be written the moment the hook started, so it could not carry
 * a verdict: the decision had not been made yet. Answering "what happened to this call?" therefore
 * meant joining this file against guard-sync-decisions.log BY TIMESTAMP, which is exactly the kind of
 * reconstruction a log exists to make unnecessary. So {@link begin} now only CAPTURES (including the
 * git/cache reads, which must still happen while the hook is running), and {@link finish} — called
 * from the hook's single terminal boundary, emitAllow/emitDeny — writes the whole line once the
 * outcome is known. The two streams stay distinct in purpose: this one is "every call and how it
 * ended", the decision log remains "every judgement and why".
 *
 * Every error is swallowed: logging must never block or fail a hook.
 */
export class InvocationLog {
    private pending: GuardInvocation | null = null;

    /**
     * Capture the context of one invocation. `cwd` is the AI's working dir; the repo root that owns
     * `.webpieces` is resolved from it. Writes NOTHING — {@link finish} does that.
     */
    begin(cwd: string, tool: string, target: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const root = new RepoRootFinder().resolveRepoRoot(cwd);
            const branch = branchForLog(root);
            // The cache is branch-keyed, so the entry to log is the one for the branch we are standing
            // on. 'unknown' (branchForLog's failure value) simply misses and logs 'sync=none'.
            const sync = summarizeSyncStatus(readMainSyncStatus(root, branch));
            this.pending = new GuardInvocation(root, new Date().toISOString(), tool, oneLine(target), branch, sync, claudeEnv.projectDirForLog());
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    /**
     * Write the captured line, now stamped with the outcome. A no-op when nothing was captured (the
     * 'rules' hook, or a terminal boundary reached before begin()), and it clears the pending entry so
     * a second emit cannot double-log.
     *
     * `rule` is the rule that blocked, or '-' when there is none; `fault` is the L0 fault code when this
     * call ended on one (S/C/Y — the JS-side faults), else '-'. FIELD ORDER IS APPEND-ONLY: the five
     * original fields keep their positions (cleanup automation mines this file), and `verdict=` /
     * `rule=` / … / `fault=` are added at the end.
     */
    finish(verdict: Verdict, rule: string, fault: string = L0_FAULT_NONE): void {
        const invocation = this.pending;
        this.pending = null;
        if (invocation === null) return;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const logsDir = dotWebpieces.logsFile(invocation.root, CALLS_STREAM);
            fs.mkdirSync(logsDir, { recursive: true });
            const logPath = path.join(logsDir, logStream.writerFile('.log'));
            rotateLogFile(logPath, path.join(logsDir, logStream.writerFile('.1.log')));

            const line = [
                `[${invocation.timestamp}]`,
                invocation.tool,
                invocation.target,
                `branch=${invocation.branch}`,
                invocation.sync,
                // `guards=`, NOT `verdict=`. This hook can only report on ITSELF. Claude Code runs all
                // three PreToolUse hooks IN PARALLEL, so the L-1 `guarantee-root.sh` process may deny a
                // call this one had no objection to, and neither can see the other's answer. Measured:
                // `cd <repo>/packages && ls` was DENIED by L-1 and recorded here three times as
                // `verdict=ALLOW`. The old field name promised an outcome it structurally cannot know;
                // the TRUE final action is the JOIN of this stream with `L-1-cd/`, which is what
                // `wp-logs` performs and what docs/tooling-logs.md now states.
                `guards=${verdict}`,
                `rule=${oneLine(rule) || '-'}`,
                // The tree the guard ACTED in, next to what Claude Code said the project was. Both, on
                // every line, because the diagnostic value is entirely in comparing them — see
                // ClaudeEnv for the open question this field exists to settle empirically.
                `root=${invocation.root}`,
                `projectDir=${invocation.projectDir}`,
                // See logGuardDecision: the short tree label, so `tree=primary` with a matching
                // projectDir reads as healthy at a glance and `tree=<worktree>` beside a projectDir
                // pointing at the primary is the straddle, without diffing two absolute paths.
                `tree=${dotWebpieces.worktreeName(invocation.root) || 'primary'}`,
                // WHICH L0 fault ended this call, in the same letters and the same field name the L0 sh
                // shim uses (ai-hook-shim.log) — so ONE grep spans the whole trail.
                `fault=${fault}`,
            ].join('\t') + '\n';
            fs.appendFileSync(logPath, line);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }
}

// Process-wide instance: one hook process handles exactly one tool call, so a single pending entry is
// the whole state there is. Module-scope (rather than DI) because the terminal boundary that flushes
// it — emitAllow/emitDeny — is itself module-scope protocol code with no container in reach.
export const invocationLog = new InvocationLog();

// One-field summary of main-sync-status.json for the invocation log: the branch the cache is FOR,
// whether it is already merged (and its PR), fork-point presence, and conflict state — the signals a
// cleanup step keys off. 'sync=none' when the cache has not been written yet (first call of a session).
function summarizeSyncStatus(status: MainSyncStatus | null): string {
    if (status === null) return 'sync=none';
    const merged = status.branchAlreadyMerged ? `PR#${status.mergedPr !== '' ? status.mergedPr : '?'}` : 'no';
    return `sync=${status.branch} merged=${merged} fork=${String(status.hasForkPoint)} conflict=${String(status.conflict)} ts=${status.timestamp}`;
}

// Best-effort current branch for the log line. Returns 'unknown' on any failure (e.g. not a git
// repo) — this is for display only, never for a control decision.
export function branchForLog(root: string): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: root,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim() || 'unknown';
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return 'unknown';
    }
}

// Collapse newlines/tabs and cap length so one decision is always one log line.
function oneLine(value: string): string {
    const flat = value.replace(/[\t\r\n]+/g, ' ').trim();
    return flat.length <= MAX_TARGET_LEN ? flat : flat.slice(0, MAX_TARGET_LEN) + '…';
}

function rotateLogFile(logPath: string, prevPath: string): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const stat = fs.statSync(logPath);
        if (stat.size > MAX_LOG_BYTES) {
            if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
            fs.renameSync(logPath, prevPath);
        }
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
}
