import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    AtomicFile, ChecklistResult, ReviewJsonService, WRITE_REVIEW_BIN, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/** `harness` for a verdict submitted from a plain terminal — a HUMAN reviewer, with no AI harness at all. */
export const HARNESS_TERMINAL = 'terminal';

const WHAT_THIS_IS =
    'PROVENANCE — written by pnpm wp-write-review beside the verdict it submitted, never by an AI. It records ' +
    'WHO submitted that verdict (harness, session, agent — as the harness reported them to the PreToolUse ' +
    'hook), WHICH commit and in-scope diff the reviewer was briefed on, and a hash of the verdict itself. ' +
    'wp-finish-upsert-pr rejects a verdict with no provenance, or one edited after submission. Do not ' +
    'hand-edit or copy it: that is forging a review.';

/** A verdict exactly as `wp-write-review` accepts it — the five fields and nothing else. Data-only. */
export class SubmittedVerdict {
    id: string;
    status: string;
    agent: string;
    model: string;
    output: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, status: string, agent: string, model: string, output: string) {
        this.id = id;
        this.status = status;
        this.agent = agent;
        this.model = model;
        this.output = output;
    }
}

/**
 * The record `wp-write-review` writes to `review-<id>.provenance.json`. Data-only; field names are the JSON
 * keys, `_WHAT_THIS_IS` first so a reader learns what the file is before anything it might act on.
 */
export class VerdictProvenance {
    // webpieces-disable naming-convention -- the leading underscore marks a note-to-the-reader key, not data
    _WHAT_THIS_IS = WHAT_THIS_IS;
    writer: string;          // always WRITE_REVIEW_BIN — a record naming anything else was not written by it
    checklistId: string;
    harness: string;         // 'claude-code' | 'codex' | HARNESS_TERMINAL
    sessionId: string;
    agentId: string;         // the SUBAGENT that submitted; '' only for HARNESS_TERMINAL
    agentType: string;
    headSha: string;         // the commit stage ② briefed this reviewer on
    scopeHash: string;       // ChecklistScopeHasher's hash of this checklist's in-scope diff at that commit
    status: string;          // the status as submitted
    verdictHash: string;     // VerdictProvenanceService.canonicalHash of the verdict as submitted
    writtenAt: string;
    round: number;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(checklistId: string, harness: string, sessionId: string, agentId: string, agentType: string, headSha: string, scopeHash: string) {
        this.writer = WRITE_REVIEW_BIN;
        this.checklistId = checklistId;
        this.harness = harness;
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.agentType = agentType;
        this.headSha = headSha;
        this.scopeHash = scopeHash;
        this.status = '';
        this.verdictHash = '';
        this.writtenAt = '';
        this.round = 0;
    }
}

/** A live verdict that stands: submitted through the bin and judged the in-scope diff as it is NOW. */
export const STANDING_CURRENT = 'current';
/** Submitted through the bin, but the checklist's in-scope diff has changed since — it judged other code. */
export const STANDING_STALE = 'stale';
/** No bin provenance, or edited after submission: not a reviewer's verdict at all. */
export const STANDING_REJECTED = 'rejected';
/**
 * Would be STALE, but still COUNTS (issue #1051): either the reviewer-round budget is spent, so no review
 * round can ever re-judge it and demanding one would deadlock the branch, or a human override for its
 * checklist stands. The reason says which, and is printed verbatim.
 */
export const STANDING_CARRIED = 'carried';

/**
 * How ONE existing verdict file stands against the branch as it is now. Data-only. Carried on the
 * checklist scan so stage ② (which briefs) and stage ③ (which blocks) read one answer.
 */
export class VerdictStanding {
    checklistId: string;
    standing: string;   // STANDING_CURRENT | STANDING_STALE | STANDING_REJECTED | STANDING_CARRIED
    status: string;     // the verdict's own green | yellow | red
    fromSha: string;    // the commit it was briefed on ('' when rejected)
    reason: string;     // why — printed verbatim

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(checklistId: string, standing: string, status: string, fromSha: string, reason: string) {
        this.checklistId = checklistId;
        this.standing = standing;
        this.status = status;
        this.fromSha = fromSha;
        this.reason = reason;
    }
}

/**
 * Writes a submitted verdict WITH its provenance, and judges an existing verdict against it (issue #863).
 *
 * This is what closes the forgery the issue measured: a Codex coordinator wrote five `review-<id>.json`
 * files itself and the gate accepted them, because nothing distinguished a reviewer's verdict from a file
 * that merely had the right shape. Now a verdict counts only when `wp-write-review` wrote it — which it does
 * only for a caller the harness identified as a subagent — and only while it still says exactly what was
 * submitted.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class VerdictProvenanceService {
    constructor(
        private readonly reviewJsonService: ReviewJsonService,
        private readonly atomicFile: AtomicFile,
    ) {}

    /** `review-<id>.provenance.json`, beside the verdict. */
    provenancePath(summaryPath: string, checklistId: string): string {
        return path.join(path.dirname(summaryPath), `review-${checklistId}.provenance.json`);
    }

    /**
     * sha256 over the five fields in a FIXED order, so formatting, key order and whitespace outside the
     * values cannot move it — only a change to what the verdict SAYS can.
     */
    canonicalHash(verdict: SubmittedVerdict): string {
        const canonical = JSON.stringify([verdict.id, verdict.status, verdict.agent, verdict.model, verdict.output]);
        return crypto.createHash('sha256').update(canonical).digest('hex');
    }

    /** Write the verdict, then its provenance. Returns the verdict path. */
    write(summaryPath: string, verdict: SubmittedVerdict, provenance: VerdictProvenance): string {
        const verdictPath = this.reviewJsonService.checklistResultPath(summaryPath, verdict.id);
        provenance.status = verdict.status;
        provenance.verdictHash = this.canonicalHash(verdict);
        provenance.writtenAt = new Date().toISOString();
        this.atomicFile.writeJsonAtomic(verdictPath, verdict);
        this.atomicFile.writeJsonAtomic(this.provenancePath(summaryPath, verdict.id), provenance);
        return verdictPath;
    }

    /** The provenance for one checklist, or null when there is none (or it is unreadable). */
    read(summaryPath: string, checklistId: string): VerdictProvenance | null {
        const file = this.provenancePath(summaryPath, checklistId);
        if (!fs.existsSync(file)) return null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable record is treated as no record, which REJECTS the verdict
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed field-by-field below
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            const record = new VerdictProvenance(
                this.str(raw['checklistId']), this.str(raw['harness']), this.str(raw['sessionId']),
                this.str(raw['agentId']), this.str(raw['agentType']), this.str(raw['headSha']), this.str(raw['scopeHash']));
            record.writer = this.str(raw['writer']);
            record.status = this.str(raw['status']);
            record.verdictHash = this.str(raw['verdictHash']);
            record.writtenAt = this.str(raw['writtenAt']);
            record.round = typeof raw['round'] === 'number' && Number.isInteger(raw['round']) ? raw['round'] as number : 0;
            return record;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * How one parsed verdict stands. `currentScopeHash` is this checklist's scope hash NOW ('' when it
     * could not be computed, which never marks anything stale).
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    assess(summaryPath: string, result: ChecklistResult, currentScopeHash: string): VerdictStanding {
        const id = result.id;
        const record = this.read(summaryPath, id);
        const reject = (reason: string): VerdictStanding => new VerdictStanding(id, STANDING_REJECTED, result.status, '', reason);
        if (record === null) {
            const file = this.provenancePath(summaryPath, id);
            const why = fs.existsSync(file) ? `${path.basename(file)} is unreadable` : `no ${path.basename(file)}`;
            return reject(`review-${id}.json was not submitted through pnpm ${WRITE_REVIEW_BIN} (${why}) — a hand-written verdict is not a review`);
        }
        if (record.writer !== WRITE_REVIEW_BIN || record.checklistId !== id) {
            return reject(`review-${id}.provenance.json was not written by ${WRITE_REVIEW_BIN} for this checklist`);
        }
        if (record.agentId.trim() === '' && record.harness !== HARNESS_TERMINAL) {
            return reject(`review-${id}.json was submitted by the coordinating agent, not a reviewer subagent`);
        }
        const submitted = new SubmittedVerdict(id, result.status, result.agent, result.model, result.output);
        if (this.canonicalHash(submitted) !== record.verdictHash) {
            return reject(`review-${id}.json was EDITED after ${WRITE_REVIEW_BIN} wrote it — a verdict is the reviewer's words, not a draft`);
        }
        if (currentScopeHash !== '' && record.scopeHash !== currentScopeHash) {
            return new VerdictStanding(id, STANDING_STALE, result.status, record.headSha,
                `in-scope files CHANGED since the verdict was written at ${this.short(record.headSha)}`);
        }
        return new VerdictStanding(id, STANDING_CURRENT, result.status, record.headSha,
            `in-scope files unchanged since ${this.short(record.headSha)}`);
    }

    /** The first 8 characters of a sha, the way every banner line prints one. */
    short(sha: string): string {
        return sha === '' ? '(unknown sha)' : sha.slice(0, 8);
    }

    // webpieces-disable no-any-unknown -- one opaque JSON value, narrowed to a string
    private str(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }
}
