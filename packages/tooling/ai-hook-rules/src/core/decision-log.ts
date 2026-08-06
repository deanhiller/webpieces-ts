import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { dotWebpieces, readMainSyncStatus, MainSyncStatus, RepoRootFinder, claudeEnv } from '@webpieces/rules-config';

import { AgentIdentity, UNKNOWN_AGENT } from './coordinator-worktree';
import { L0_FAULT_NONE } from './l0-fault-codes';
import { toError } from './to-error';

// The SYNC decision log — what the synchronous hook DID on each invocation and WHY. Its companion is
// the ASYNC log (guard-async-work.log, written by the detached refresher in main-sync-log.ts). This
// one records EVERY guard decision — allow, block, config-bypass, and the fail-open cases — and CITES
// the async-written cache snapshot (`cache` field) that drove the decision, so a wrong allow/block is
// traceable to a stale or missing async write. Writes to `.webpieces/logs/guard-sync-decisions.log`
// (see LOGS_STATE_DIR: every webpieces log lives under `logs/`, never beside `hooks/`'s non-log state).
const LOG_FILE = 'guard-sync-decisions.log';
const LOG_FILE_PREV = 'guard-sync-decisions.1.log';
// The per-INVOCATION stream (companion to the per-DECISION log above): one line for every guards-hook
// call, so cleanup automation can mine tool + branch + sync-status + OUTCOME over time. See InvocationLog.
const INVOCATION_LOG_FILE = 'guard-invocations.log';
const INVOCATION_LOG_FILE_PREV = 'guard-invocations.1.log';
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded (mirrors rejection-log)
const MAX_TARGET_LEN = 160;

export type Verdict = 'ALLOW' | 'BLOCK';

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

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(rule: string, tool: string, target: string, branch: string, verdict: Verdict, reason: string, cache: string = '-', fault: string = L0_FAULT_NONE) {
        this.rule = rule;
        this.tool = tool;
        this.target = target;
        this.branch = branch;
        this.verdict = verdict;
        this.reason = reason;
        this.cache = cache;
        this.fault = fault;
    }
}

/**
 * Append one tab-separated line per decision to `.webpieces/logs/guard-sync-decisions.log`. `root` is
 * the repo/workspace root that holds `.webpieces` (callers pass workspaceRoot, or a
 * RepoRootFinder-resolved root at the pre-load config-bypass site — never a raw cwd, so a bypass
 * logged from a subdir never scatters a stray `.webpieces`). Swallows all errors — logging must never
 * block or fail a hook.
 *
 * `agent` selects WHICH stream: a subagent sharing the coordinator's tree gets
 * `logs/agents/<agentId>/`, the coordinator keeps `logs/` unchanged. See DotWebpieces.agentLogs.
 */
// webpieces-disable no-function-outside-class -- the module-scope writer this log has always been, beside branchForLog/oneLine/rotateLogFile; it must stay callable from a tree too broken to build a DI container
export function logGuardDecision(root: string, decision: GuardDecision, agent: AgentIdentity = UNKNOWN_AGENT): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const timestamp = new Date().toISOString();
        // LOCAL scope, and per-AGENT within it: a guard decision belongs to the tree it judged, and one
        // writer per (tree, agent) is what makes the appends untangleable.
        const logsDir = dotWebpieces.agentLogs(root, agent.logNamespace);
        fs.mkdirSync(logsDir, { recursive: true });

        const logPath = path.join(logsDir, LOG_FILE);
        rotateLogFile(logPath, path.join(logsDir, LOG_FILE_PREV));

        const line = [
            `[${timestamp}]`,
            decision.verdict,
            decision.tool,
            oneLine(decision.target),
            decision.branch,
            decision.rule,
            oneLine(decision.reason),
            oneLine(decision.cache),
            // The tree this decision was actually made against, and what Claude Code told the hook the
            // project was. Appended (never reordered) for the same reason as on the invocation line —
            // see ClaudeEnv: when these two disagree, that disagreement is the bug.
            `root=${root}`,
            `projectDir=${claudeEnv.projectDirForLog()}`,
            // git's name for that tree — `primary`, else the worktree name. Same literal and same
            // derivation as the L0 shim log's `tree=` (shim-audit-log.ts), so one grep spans both
            // streams: L0 carries tree without projectDir, L1 now carries both.
            `tree=${dotWebpieces.worktreeName(root) || 'primary'}`,
            // The two APPEND-ONLY audit fields, same spelling as the invocation line and as the L0 shim
            // log's `fault=`: which L0 fault this was (or `-`), and who made the call.
            `fault=${decision.fault}`,
            `agent=${agent.logLabel}`,
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
        /**
         * WHO made this call. Captured at begin() rather than passed to finish(), because the terminal
         * boundary that flushes the line (emitAllow/emitDeny) has no payload in reach — and because the
         * identity is a property of the invocation, not of its outcome.
         */
        public readonly agent: AgentIdentity = UNKNOWN_AGENT,
    ) {}
}

/**
 * The per-INVOCATION stream — `.webpieces/logs/guard-invocations.log`, one line for EVERY guards-hook
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
    begin(cwd: string, tool: string, target: string, agent: AgentIdentity = UNKNOWN_AGENT): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const root = new RepoRootFinder().resolveRepoRoot(cwd);
            const branch = branchForLog(root);
            // The cache is branch-keyed, so the entry to log is the one for the branch we are standing
            // on. 'unknown' (branchForLog's failure value) simply misses and logs 'sync=none'.
            const sync = summarizeSyncStatus(readMainSyncStatus(root, branch));
            this.pending = new GuardInvocation(root, new Date().toISOString(), tool, oneLine(target), branch, sync, claudeEnv.projectDirForLog(), agent);
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
     * `rule=` / … / `fault=` / `agent=` are added at the end.
     */
    finish(verdict: Verdict, rule: string, fault: string = L0_FAULT_NONE): void {
        const invocation = this.pending;
        this.pending = null;
        if (invocation === null) return;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // Per-agent within the tree: a subagent that shares the coordinator's checkout gets its own
            // file instead of interleaving into the coordinator's. See DotWebpieces.agentLogs.
            const logsDir = dotWebpieces.agentLogs(invocation.root, invocation.agent.logNamespace);
            fs.mkdirSync(logsDir, { recursive: true });
            const logPath = path.join(logsDir, INVOCATION_LOG_FILE);
            rotateLogFile(logPath, path.join(logsDir, INVOCATION_LOG_FILE_PREV));

            const line = [
                `[${invocation.timestamp}]`,
                invocation.tool,
                invocation.target,
                `branch=${invocation.branch}`,
                invocation.sync,
                `verdict=${verdict}`,
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
                // shim uses (ai-hook-shim.log) — so ONE grep spans the whole trail — and WHO made it,
                // which stays on the line even after the per-agent split so a merged read still says.
                `fault=${fault}`,
                `agent=${invocation.agent.logLabel}`,
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
