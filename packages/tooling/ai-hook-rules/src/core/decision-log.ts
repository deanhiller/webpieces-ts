import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { toError } from './to-error';

// The SYNC decision log — what the synchronous hook DID on each invocation and WHY. Its companion is
// the ASYNC log (guard-async-work.log, written by the detached refresher in main-sync-log.ts). This
// one records EVERY guard decision — allow, block, config-bypass, and the fail-open cases — and CITES
// the async-written cache snapshot (`cache` field) that drove the decision, so a wrong allow/block is
// traceable to a stale or missing async write. Writes to `.webpieces/hooks/guard-sync-decisions.log`.
const HOOKS_DIR = '.webpieces/hooks';
const LOG_FILE = 'guard-sync-decisions.log';
const LOG_FILE_PREV = 'guard-sync-decisions.1.log';
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

    constructor(rule: string, tool: string, target: string, branch: string, verdict: Verdict, reason: string, cache: string = '-') {
        this.rule = rule;
        this.tool = tool;
        this.target = target;
        this.branch = branch;
        this.verdict = verdict;
        this.reason = reason;
        this.cache = cache;
    }
}

/**
 * Append one tab-separated line per decision to `.webpieces/hooks/guard-sync-decisions.log`. `root` is
 * the repo/workspace root that holds `.webpieces` (callers pass workspaceRoot, or process.cwd() at
 * the pre-load config-bypass site). Swallows all errors — logging must never block or fail a hook.
 */
export function logGuardDecision(root: string, decision: GuardDecision): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const timestamp = new Date().toISOString();
        const hooksDir = path.join(root, HOOKS_DIR);
        fs.mkdirSync(hooksDir, { recursive: true });

        const logPath = path.join(hooksDir, LOG_FILE);
        rotateLogFile(logPath, path.join(hooksDir, LOG_FILE_PREV));

        const line = [
            `[${timestamp}]`,
            decision.verdict,
            decision.tool,
            oneLine(decision.target),
            decision.branch,
            decision.rule,
            oneLine(decision.reason),
            oneLine(decision.cache),
        ].join('\t') + '\n';
        fs.appendFileSync(logPath, line);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
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
