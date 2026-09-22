import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';
import { AtomicFile } from './atomic-file';
import { DotWebpieces, dotWebpieces } from './state-dir';
import { toError } from './to-error';

/** The ONE sanctioned way a reviewer submits a checklist verdict (issue #863). */
export const WRITE_REVIEW_BIN = 'wp-write-review';

/** The flag that names the checklist a `wp-write-review` call submits for. */
export const WRITE_REVIEW_CHECKLIST_FLAG = '--checklist';

/** Where the stamps live, beneath this worktree's tooling-owned state dir (never the AI-writable one). */
export const REVIEW_STAMP_DIR = 'review-stamps';

/**
 * How long a stamp stays usable. The hook writes it a few milliseconds before the harness starts the very
 * Bash command it stamped, so anything older than this is left over from a call that never reached the bin
 * — and must not be available to lend its identity to a later caller.
 */
export const REVIEW_STAMP_MAX_AGE_MS = 120_000;

/**
 * WHO is running a `pnpm wp-write-review` Bash call, as the HARNESS reported it to the PreToolUse hook.
 * Data-only (per CLAUDE.md), and its field names are the JSON keys on disk.
 *
 * WHY a hook stamp and not the environment (issue #863). A Bash-invoked bin sees only its env, and the env
 * cannot answer "is this a subagent?" in either harness:
 *   - Claude Code exports `CLAUDE_CODE_SESSION_ID`, which is the PARENT session's id in a subagent too, and
 *     no agent id at all — a reviewer and its coordinator have byte-identical identity env.
 *   - Codex exports `CODEX_SESSION_ID` / `CODEX_THREAD_ID`, and nothing documents (or has been measured to
 *     show) that a spawned subagent gets a thread id of its own rather than inheriting the coordinator's.
 * The hook payload DOES carry the answer, in both harnesses, on the same key: `agent_id` is empty for the
 * main loop and populated for a subagent. So the hook — which sees every Bash call before it runs — writes
 * that identity here for each checklist the command names, and the bin consumes it.
 *
 * NOT tamper-proof, and not claimed to be: an agent can write this file by hand. It moves forging a verdict
 * from "write one JSON file" (what a coordinator did on two merged PRs) to a deliberate, auditable forgery of
 * tooling state outside the AI-writable dir — the same bar SubagentProvenanceService sets.
 */
export class ReviewIdentityStamp {
    checklistId: string;
    aiType: string;       // 'claude-code' | 'codex' — the adapter's answer, never the model's
    sessionId: string;
    agentId: string;      // '' ⇒ the MAIN loop, i.e. the coordinating agent
    agentType: string;
    cwd: string;
    stampedAt: string;    // ISO

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(checklistId: string, aiType: string, sessionId: string, agentId: string, agentType: string, cwd: string, stampedAt: string) {
        this.checklistId = checklistId;
        this.aiType = aiType;
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.agentType = agentType;
        this.cwd = cwd;
        this.stampedAt = stampedAt;
    }
}

/**
 * Writes (from the PreToolUse hook) and consumes (from `wp-write-review`) {@link ReviewIdentityStamp}s.
 *
 * Both ends resolve the path from their OWN working directory through {@link DotWebpieces.local}, which is
 * keyed by git's answer for that tree — so the hook's payload cwd and the bin's process cwd land on the same
 * file for the same worktree, and two worktrees never share a stamp.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type; {@link reviewIdentityStamps} is the
 * instance the dependency-free hook adapter uses.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewIdentityStampService {
    constructor(
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly atomicFile: AtomicFile = new AtomicFile(),
    ) {}

    /**
     * The checklist ids a Bash command submits verdicts for, or [] when it does not invoke the bin at all.
     * Every `--checklist <id>` / `--checklist=<id>` is returned, because one reviewer covering several
     * checklists may chain several submissions into one command.
     */
    invokedChecklists(command: string): string[] {
        if (!new RegExp(`\\b${WRITE_REVIEW_BIN}\\b`).test(command)) return [];
        const ids: string[] = [];
        const flag = /--checklist(?:=|\s+)(["']?)([A-Za-z0-9._-]+)\1/g;
        let match = flag.exec(command);
        while (match !== null) {
            if (!ids.includes(match[2])) ids.push(match[2]);
            match = flag.exec(command);
        }
        return ids;
    }

    /**
     * True when the stamp names the COORDINATING agent rather than a subagent: no agent id, or an agent id
     * equal to the session id (a harness that fills the main loop's agent id with the session id instead of
     * leaving it empty). The coordinator may never submit a reviewer's verdict — that is the whole point.
     */
    isCoordinator(stamp: ReviewIdentityStamp): boolean {
        return stamp.agentId.trim() === '' || stamp.agentId === stamp.sessionId;
    }

    stampPath(startDir: string, checklistId: string): string {
        return this.dotDir.localFile(startDir, REVIEW_STAMP_DIR, `${checklistId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    }

    /** Best-effort: a stamp that cannot be written makes the bin refuse, which is the safe direction. */
    write(startDir: string, stamp: ReviewIdentityStamp): void {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the hook must never fail a tool call over its own bookkeeping
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            this.atomicFile.writeJsonAtomic(this.stampPath(startDir, stamp.checklistId), stamp);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    /**
     * Read AND delete the stamp for one checklist. null when there is none, it is unreadable, or it is
     * older than {@link REVIEW_STAMP_MAX_AGE_MS}. Deleted on read so one hook call vouches for one
     * submission; a delete that fails (a sandbox that denies it) is harmless, because age bounds it anyway.
     */
    take(startDir: string, checklistId: string, nowMs: number = Date.now()): ReviewIdentityStamp | null {
        const file = this.stampPath(startDir, checklistId);
        const stamp = this.read(file);
        this.remove(file);
        if (stamp === null || stamp.checklistId !== checklistId) return null;
        const age = nowMs - Date.parse(stamp.stampedAt);
        if (!Number.isFinite(age) || age < 0 || age > REVIEW_STAMP_MAX_AGE_MS) return null;
        return stamp;
    }

    private read(file: string): ReviewIdentityStamp | null {
        if (!fs.existsSync(file)) return null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable stamp is no stamp
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed field-by-field below
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            // webpieces-disable no-any-unknown -- one opaque JSON value, narrowed to a string
            const str = (v: unknown): string => (typeof v === 'string' ? v : '');
            return new ReviewIdentityStamp(
                str(raw['checklistId']), str(raw['aiType']), str(raw['sessionId']), str(raw['agentId']),
                str(raw['agentType']), str(raw['cwd']), str(raw['stampedAt']));
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    private remove(file: string): void {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a stamp that cannot be deleted still expires
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.rmSync(file, { force: true });
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }
}

/** The instance the hook adapter uses — it runs without a DI container (see hook-core.ts). */
export const reviewIdentityStamps = new ReviewIdentityStampService();
