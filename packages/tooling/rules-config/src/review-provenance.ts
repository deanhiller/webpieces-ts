import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { injectable, bindingScopeValues } from 'inversify';
import { toError } from './to-error';
import { ReviewerEvidence } from './subagent-provenance';

// The audit record `wp-finish-upsert-pr` writes beside review.json, and where a consumed one is retired to.
const PROVENANCE_FILE = 'provenance.json';
const OLD_PROVENANCE_FILE = 'old-provenance.json';

/**
 * Claude Code deletes transcripts after `cleanupPeriodDays`; 30 is its default and what applies when the
 * setting is absent, which is the common case. Recorded in every provenance file so a reader knows how
 * long the links it is holding remain resolvable rather than discovering it by following a dead path.
 */
export const DEFAULT_RETENTION_DAYS = 30;

const WHAT_THIS_IS =
    'AUDIT RECORD — written by wp-finish-upsert-pr, never by an AI. It links each reviewer verdict to the ' +
    'transcript of the subagent that produced it, and records what that reviewer was OFFERED versus what it ' +
    'demonstrably READ. Open it to audit the review process itself: whether a verdict was written by an ' +
    'agent that actually opened the diff and its checklist doc. Do not hand-edit it, and do not treat it as ' +
    'a review — it says nothing about whether the code is good, only about how it was looked at. The linked ' +
    'transcripts expire (see transcriptsExpireOn); the counters recorded here do not.';

/** Where ONE reviewer's inputs and output live on disk. Data-only (per CLAUDE.md). */
export class ReviewerPaths {
    verdictFile: string;       // the review-<id>.json this reviewer was told to write
    instructionsFile: string;  // its generated <subagent>.instructions.md
    docPath: string;           // its checklist's guidance doc ('' when the checklist names none)

    constructor(verdictFile: string, instructionsFile: string, docPath: string) {
        this.verdictFile = verdictFile;
        this.instructionsFile = instructionsFile;
        this.docPath = docPath;
    }
}

/**
 * ONE reviewer's provenance row: which agent ran, where its transcript is, and the evidence counters read
 * out of that transcript. Data-only, and its FIELD NAMES ARE THE JSON KEYS — the file is written by
 * serializing these objects directly, so renaming a field renames it in every consumer's audit record.
 *
 * The counters are copied here rather than left to be re-derived because the transcript they came from is a
 * wasting asset (~30 days). After it expires this row still answers "did that reviewer read the diff?".
 */
export class ReviewerTranscript {
    id: string;
    agentType: string;
    agentId: string;
    transcript: string;       // absolute path to agent-<id>.jsonl, '' when it could not be resolved
    transcriptExists: boolean;
    verdictFile: string;
    instructionsFile: string;
    docPath: string;
    readDiff: boolean;
    readDoc: boolean;
    toolCallCount: number;
    offRepoSearches: number;
    /**
     * The model(s) that ACTUALLY served this reviewer, observed in its transcript — not the `model:` its
     * agent file requested, which can silently disagree, and not anything the reviewer claimed.
     *
     * Copied here for the reason the whole class exists: the transcript is a wasting asset (~30 days),
     * and after it expires this row is the only surviving answer to "which model reviewed this?".
     */
    models: string[];

    constructor(evidence: ReviewerEvidence, paths: ReviewerPaths) {
        this.id = evidence.agentType; // a checklist's id IS its subagent name (see ChecklistDefinition)
        this.agentType = evidence.agentType;
        this.agentId = evidence.agentId;
        this.transcript = evidence.transcriptPath;
        this.transcriptExists = evidence.transcriptPath !== '' && fs.existsSync(evidence.transcriptPath);
        this.verdictFile = paths.verdictFile;
        this.instructionsFile = paths.instructionsFile;
        this.docPath = paths.docPath;
        this.readDiff = evidence.readDiff;
        this.readDoc = evidence.readDoc;
        this.toolCallCount = evidence.toolCallCount;
        this.offRepoSearches = evidence.offRepoSearches;
        this.models = evidence.models;
    }
}

/** What the reviewers were handed, whether or not any of them opened it. Data-only. */
export class OfferedContext {
    diffDir: string;
    instructionsDir: string;

    constructor(diffDir: string, instructionsDir: string) {
        this.diffDir = diffDir;
        this.instructionsDir = instructionsDir;
    }
}

/**
 * What {@link ReviewProvenanceService.write} is asked to record. Data-only; `offered` and `reviewers` are
 * assigned after construction (the same shape ChecklistCommentRow uses) so this never becomes a 7-param
 * constructor.
 */
export class ProvenanceWriteRequest {
    prDir: string;
    branch: string;
    headSha: string;
    provenanceStatus: string; // PROVENANCE_OK | PROVENANCE_MISSING | PROVENANCE_SKIPPED
    offered: OfferedContext = new OfferedContext('', '');
    reviewers: ReviewerTranscript[] = [];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(prDir: string, branch: string, headSha: string, provenanceStatus: string) {
        this.prDir = prDir;
        this.branch = branch;
        this.headSha = headSha;
        this.provenanceStatus = provenanceStatus;
    }
}

/**
 * The written record. Field names are the JSON keys, in this order — `_WHAT_THIS_IS` is declared FIRST so
 * anything that opens the file reads what it is before it reads anything it might act on, exactly as
 * ReviewJsonService.archiveReviewJson stamps its note first.
 */
export class ReviewProvenance {
    // webpieces-disable naming-convention -- the leading underscore marks a note-to-the-reader key, not data
    _WHAT_THIS_IS = WHAT_THIS_IS;
    sessionId: string;
    mainTranscript: string;
    branch: string;
    headSha: string;
    stampedAt: string;
    transcriptRetentionDays: number;
    transcriptsExpireOn: string;
    provenanceStatus: string;
    offered: OfferedContext;
    reviewers: ReviewerTranscript[];

    constructor(request: ProvenanceWriteRequest) {
        this.sessionId = '';
        this.mainTranscript = '';
        this.branch = request.branch;
        this.headSha = request.headSha;
        this.stampedAt = '';
        this.transcriptRetentionDays = DEFAULT_RETENTION_DAYS;
        this.transcriptsExpireOn = '';
        this.provenanceStatus = request.provenanceStatus;
        this.offered = request.offered;
        this.reviewers = request.reviewers;
    }
}

/**
 * Records WHICH transcript produced which verdict, so the review process itself can be audited later.
 *
 * Why a service and not a field the AI writes: a reviewer subagent CANNOT know its own transcript path. The
 * environment exposes `CLAUDE_CODE_SESSION_ID` — the PARENT session — and no agent id, so a self-reported
 * link would be invented. Every path here is derived from the harness's own artifacts:
 *   ~/.claude/projects/&#42;/<sessionId>.jsonl                            → the main agent's transcript
 *   ~/.claude/projects/&#42;/<sessionId>/subagents/agent-<id>.jsonl       → one reviewer's transcript
 * The subagent half is already resolved by {@link SubagentProvenanceService}; this carries it to disk and
 * adds the session-level facts (which session, how long the links live).
 *
 * Deliberately a SEPARATE file from review.json / review-<id>.json: those are AI-authored and stay
 * byte-untouched, so nothing here can be confused for something a reviewer claimed about itself.
 *
 * Best-effort throughout — an unreadable ~/.claude degrades the record to empty links, never fails a PR.
 * Same reasoning as SubagentProvenanceService: this reads undocumented Claude Code internals, and a format
 * change must not wedge a consumer's PR.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewProvenanceService {
    // Where the audit record for a branch lives, beside review.json.
    provenancePath(prDir: string): string {
        return path.join(prDir, PROVENANCE_FILE);
    }

    // Where a consumed record is retired to — the mirror of ReviewJsonService.oldReviewJsonPath, so an
    // archived old-review.json keeps the transcript links belonging to the round that produced it.
    oldProvenancePath(prDir: string): string {
        return path.join(prDir, OLD_PROVENANCE_FILE);
    }

    // The current Claude Code session id, or '' outside a Claude Code session (plain terminal / CI).
    sessionId(): string {
        return (process.env['CLAUDE_CODE_SESSION_ID'] ?? '').trim();
    }

    /**
     * The main agent's own transcript: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. Located by
     * scanning every project dir for the file named after the session, so the cwd-slug — which is a
     * mangling of the working directory we would otherwise have to reproduce exactly — never has to be
     * derived. '' when there is no session or the file is not there.
     */
    mainTranscript(): string {
        const session = this.sessionId();
        if (session === '') return '';
        const projects = path.join(os.homedir(), '.claude', 'projects');
        for (const proj of this.readDir(projects)) {
            const candidate = path.join(projects, proj, `${session}.jsonl`);
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
    }

    /**
     * How many days Claude Code keeps transcripts: `cleanupPeriodDays` from ~/.claude/settings.json (then
     * settings.local.json), else {@link DEFAULT_RETENTION_DAYS}. The setting is usually absent, which is
     * why the default is documented rather than left implicit.
     */
    retentionDays(): number {
        const dir = path.join(os.homedir(), '.claude');
        for (const file of ['settings.json', 'settings.local.json']) {
            const settings = this.readJson(path.join(dir, file));
            const days = settings?.['cleanupPeriodDays'];
            if (typeof days === 'number' && Number.isFinite(days) && days > 0) return days;
        }
        return DEFAULT_RETENTION_DAYS;
    }

    /**
     * The date the FIRST of these transcripts becomes unreadable: the oldest one's mtime + retentionDays,
     * as an ISO date. The oldest rather than the newest because that is when the audit trail starts losing
     * links, and a reader planning to follow them needs the pessimistic answer. '' when none exist.
     */
    expiresOn(transcripts: readonly string[], retentionDays: number): string {
        let oldest = 0;
        for (const file of transcripts) {
            const mtime = this.mtimeOf(file);
            if (mtime !== 0 && (oldest === 0 || mtime < oldest)) oldest = mtime;
        }
        if (oldest === 0) return '';
        const expiry = new Date(oldest + retentionDays * 24 * 60 * 60 * 1000);
        return expiry.toISOString().slice(0, 10);
    }

    /**
     * Write the record to `<prDir>/provenance.json` and return its path ('' if it could not be written).
     *
     * Written on EVERY finish, including one that refuses for a missing reviewer: a refused round is
     * precisely the one worth auditing, and a record that only ever appears on success cannot answer "what
     * did the reviewers do the time this was rejected?".
     */
    write(request: ProvenanceWriteRequest): string {
        const provenance = this.build(request);
        const target = this.provenancePath(request.prDir);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the audit record is never worth failing a PR over
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.mkdirSync(request.prDir, { recursive: true });
            fs.writeFileSync(target, JSON.stringify(provenance, null, 2) + '\n');
            return target;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }

    // Retire the record for the round that just shipped: copy it to old-provenance.json beside the
    // old-review.json it belongs to. A COPY, not a move — unlike review.json this file is not an input to
    // anything, so leaving it in place cannot mislead a later reviewer, and the next finish overwrites it.
    archive(prDir: string): string {
        const source = this.provenancePath(prDir);
        if (!fs.existsSync(source)) return '';
        const target = this.oldProvenancePath(prDir);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a failed archive must not fail the command
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.copyFileSync(source, target);
            return target;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }

    // Fill in the session-level facts the caller cannot know: which session, which transcripts, how long.
    private build(request: ProvenanceWriteRequest): ReviewProvenance {
        const provenance = new ReviewProvenance(request);
        provenance.sessionId = this.sessionId();
        provenance.mainTranscript = this.mainTranscript();
        provenance.stampedAt = new Date().toISOString();
        provenance.transcriptRetentionDays = this.retentionDays();
        const linked = [provenance.mainTranscript, ...request.reviewers.map(
            (r: ReviewerTranscript): string => r.transcript)].filter((p: string): boolean => p !== '');
        provenance.transcriptsExpireOn = this.expiresOn(linked, provenance.transcriptRetentionDays);
        return provenance;
    }

    // Epoch millis of a file's mtime, or 0 when it cannot be read.
    private mtimeOf(filePath: string): number {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unstattable transcript contributes no expiry
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.statSync(filePath).mtime.getTime();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return 0;
        }
    }

    private readDir(dir: string): string[] {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable dir yields [] (best-effort)
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readdirSync(dir);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON object, keys read by the caller
    private readJson(filePath: string): Record<string, unknown> | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: malformed settings → null (fall through to the default)
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed by the caller
            return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }
}
