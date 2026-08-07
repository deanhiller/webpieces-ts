import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { injectable, bindingScopeValues } from 'inversify';
import { toError } from './to-error';
import { dotWebpieces } from './state-dir';

// Outcome of a provenance check.
export const PROVENANCE_OK = 'ok';           // a matching reviewer subagent demonstrably ran on this branch
export const PROVENANCE_MISSING = 'missing'; // session known, but no matching subagent artifact found → refuse (BLOCK)
export const PROVENANCE_SKIPPED = 'skipped'; // no CLAUDE_CODE_SESSION_ID (plain terminal / CI) → warn + pass

export class ProvenanceResult {
    status: string; // PROVENANCE_OK | PROVENANCE_MISSING | PROVENANCE_SKIPPED
    detail: string; // human-readable explanation for the warning/error/dashboard
    // agentIds credited, keyed by agentType, so an evidence pass does not re-scan to find them again.
    agentIds: Record<string, string>;

    constructor(status: string, detail: string, agentIds: Record<string, string> = {}) {
        this.status = status;
        this.detail = detail;
        this.agentIds = agentIds;
    }
}

/**
 * What ONE credited reviewer actually DID, read from its own transcript. Data-only (per CLAUDE.md).
 *
 * `verifyDistinct` answers "did a reviewer of this type run?" — an INTEGRITY question, and it blocks. This
 * answers "did it look at the change?" — a QUALITY question, and it only warns. The distinction is
 * deliberate; see {@link SubagentProvenanceService.evidenceFor}.
 */
export class ReviewerEvidence {
    agentType: string;
    agentId: string;
    readDiff: boolean;       // opened the materialized diff dir (or its own instructions file)
    readDoc: boolean;        // opened its checklist's guidance doc
    toolCallCount: number;
    offRepoSearches: number; // tool calls that reached into node_modules — the archaeology signal
    /**
     * Distinct `message.model` values OBSERVED in the transcript, in first-seen order.
     *
     * The model that actually ran, never the one that was configured — and never anything the reviewer
     * says about itself. A checklist's `.claude/agents/<subagent>.md` declares `model:`, but that is the
     * REQUESTED value and it can silently disagree with what served the request: a repo was measured
     * running opus for a reviewer whose agent file said `model: sonnet`. Asking the model instead would
     * be worse — a model is unreliable about its own identity, naming a family instead of a version or
     * repeating whatever the system prompt implied, so a self-reported field is usually right and
     * silently wrong, which is the worst kind of telemetry because it looks authoritative.
     * `message.model` is written by the harness, so this inherits the anti-forgery property the rest of
     * this class documents.
     *
     * An ARRAY, not a string: one reviewer run can span more than one model (a fallback after a refusal,
     * a mid-run config change). Collapsing to one value forces a lossy choice at read time; recording
     * what happened lets the renderer decide.
     *
     * Token counts and cost are deliberately NOT here. Prices change, vary by platform and differ under
     * intro pricing, so a rate table in this package would rot silently — and the question this answers
     * is "which model reviewed this?", not "what did it cost?".
     */
    models: string[];
    // Absolute path of the transcript these counters were read out of, '' when it could not be resolved.
    // Carried out rather than recomputed because a reviewer subagent cannot learn its own transcript path
    // (the environment exposes the PARENT session id and no agent id), so this is the only place it is
    // known — see ReviewProvenanceService, which records it as the audit link for the verdict.
    transcriptPath: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(agentType: string, agentId: string, readDiff = false, readDoc = false, toolCallCount = 0, offRepoSearches = 0, transcriptPath = '', models: string[] = []) {
        this.agentType = agentType;
        this.agentId = agentId;
        this.readDiff = readDiff;
        this.readDoc = readDoc;
        this.toolCallCount = toolCallCount;
        this.offRepoSearches = offRepoSearches;
        this.transcriptPath = transcriptPath;
        this.models = models;
    }
}

/**
 * One pass over one transcript: the tool inputs AND the models that served it. Data-only.
 *
 * They are gathered together rather than in two passes because they come from the SAME records — the
 * inputs from `message.content[].input`, the model from `message.model` one level up — and a transcript
 * is the largest file this service opens. Two reads of it to answer two questions about the same lines
 * would be the duplicate-work trap the diff materializer documents at length.
 */
export class TranscriptScan {
    inputs: string[];   // every tool_use input, JSON-stringified
    models: string[];   // distinct message.model values, first-seen order

    constructor(inputs: string[] = [], models: string[] = []) {
        this.inputs = inputs;
        this.models = models;
    }
}

/** What to look for when reading reviewer transcripts. Data-only — avoids a 5-param method. */
export class EvidenceRequest {
    branch: string;
    agentIds: Record<string, string>; // agentType → agentId, straight from ProvenanceResult
    diffDir: string;                  // '' when nothing was materialized
    docPaths: Record<string, string>; // agentType → its checklist doc path ('' when none)

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(branch: string, agentIds: Record<string, string>, diffDir = '', docPaths: Record<string, string> = {}) {
        this.branch = branch;
        this.agentIds = agentIds;
        this.diffDir = diffDir;
        this.docPaths = docPaths;
    }
}

/**
 * Verifies — from the Claude Code harness's OWN artifacts, never from anything the model asserts — that
 * a subagent of a given `agentType` actually ran during the current session on the current branch. Used
 * to enforce a checklist's optional `subagent:` field: that an INDEPENDENT reviewer looked, rather than
 * the coding agent self-certifying.
 *
 * The harness writes, beside each subagent transcript:
 *   ~/.claude/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.meta.json  → { agentType, spawnDepth, … }
 *   ~/.claude/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl      → record 0 { isSidechain, gitBranch, … }
 * `agentType`/`spawnDepth`/`isSidechain` are written by Claude Code, not by the model. We locate the dir
 * by the unique sessionId (globbing `projects/&#42;/<sessionId>/subagents`), so the cwd-slug never has to be
 * derived/guessed.
 *
 * IMPORTANT — this is NOT tamper-proof. A determined agent can `cat >` a fake agent-*.meta.json. This
 * raises the bar from "trust the model's word" to "deliberate, auditable forgery outside the repo"; it
 * is not cryptographic. Say so wherever `subagent:` is documented.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class SubagentProvenanceService {
    // cwd → the branch it is PINNED to ('' when it is not a linked worktree, or is unresolvable).
    // See branchOfCwd for why it is cached and pinnedBranch for what "pinned" buys.
    private readonly branchByCwd = new Map<string, string>();

    // Verify a subagent of `expectedAgentType` ran on `branch`. Absent CLAUDE_CODE_SESSION_ID (plain
    // terminal / CI) returns SKIPPED — the feature must not break non-Claude-Code consumers.
    verify(expectedAgentType: string, branch: string): ProvenanceResult {
        if (!this.inClaudeSession()) return this.skipped(`the "${expectedAgentType}" reviewer subagent`);
        const dirs = this.allSubagentsDirs();
        const agentId = this.findMatchingAgentId(dirs, expectedAgentType, branch);
        return agentId !== ''
            ? new ProvenanceResult(PROVENANCE_OK, `verified "${expectedAgentType}" reviewer subagent ran (agent ${agentId}).`)
            : new ProvenanceResult(PROVENANCE_MISSING,
                `No "${expectedAgentType}" reviewer subagent ran on this branch — a separate reviewer of that type must review this checklist.`);
    }

    // Verify EVERY expected reviewer subagent ran on `branch` as a DISTINCT run — the coding agent may not
    // self-certify, and one reviewer may not stand in for several. SKIPPED (pass) without a session id.
    //
    // Scoped by BRANCH across ALL sessions (not the current session): once a reviewer ran on this branch in
    // any session, a later re-push in a NEW session still finds it, so the review is NOT forced to re-run.
    // That is what keeps "review once per branch" true across sessions. A PR opened outside the gated flow
    // still has no review-<id>.json, so wp-finish forces the review regardless of provenance.
    verifyDistinct(expectedAgentTypes: readonly string[], branch: string): ProvenanceResult {
        if (expectedAgentTypes.length === 0) return new ProvenanceResult(PROVENANCE_OK, 'no reviewer subagents required');
        if (!this.inClaudeSession()) return this.skipped('reviewer subagents');
        const dirs = this.allSubagentsDirs();
        const missing: string[] = [];
        const usedAgentIds = new Set<string>();
        const credited: Record<string, string> = {};
        for (const type of expectedAgentTypes) {
            const agentId = this.findMatchingAgentId(dirs, type, branch, usedAgentIds);
            if (agentId === '') missing.push(type);
            else {
                usedAgentIds.add(agentId);
                credited[type] = agentId;
            }
        }
        return missing.length === 0
            ? new ProvenanceResult(PROVENANCE_OK, `verified ${expectedAgentTypes.length} distinct reviewer subagent(s) ran`, credited)
            : new ProvenanceResult(PROVENANCE_MISSING,
                `these reviewer subagents did not run on this branch (spawn each as its OWN subagent — do not self-certify): ${missing.join(', ')}`,
                credited);
    }

    /**
     * What each credited reviewer actually READ, from its own transcript.
     *
     * `verifyDistinct` proves a reviewer of the right type RAN. It cannot tell a reviewer that read the diff
     * and thought about it from one that wrote a verdict having opened nothing. This closes that gap — and
     * the motivating case is real: one reviewer spent 14 of 26 tool calls grepping `node_modules` because
     * nothing had told it where anything was, which `offRepoSearches` now makes visible.
     *
     * WARNING-ONLY by default, for three reasons, and `requireDiffEvidence` must stay opt-in until at least
     * one repo has watched it:
     *   1. The transcript layout is undocumented Claude Code internals. A format change would wedge every
     *      consumer's PR with no self-service recovery — `sidechainOnBranch` is already lenient for exactly
     *      this reason, and blocking on a richer read of the same files would be less safe, not more.
     *   2. A reviewer can legitimately receive the diff another way (inlined into its prompt, say).
     *   3. verifyDistinct is the INTEGRITY signal and rightly blocks; this is a QUALITY signal. Conflating
     *      them would let a transcript-parsing quirk refuse a PR that a real reviewer really did review.
     *
     * Returns [] outside a Claude Code session, matching verify/verifyDistinct's SKIP behavior.
     */
    evidenceFor(request: EvidenceRequest): ReviewerEvidence[] {
        if (!this.inClaudeSession()) return [];
        const dirs = this.allSubagentsDirs();
        const out: ReviewerEvidence[] = [];
        for (const agentType of Object.keys(request.agentIds)) {
            const agentId = request.agentIds[agentType];
            const jsonl = this.transcriptPath(dirs, agentId);
            if (jsonl === '') {
                out.push(new ReviewerEvidence(agentType, agentId));
                continue;
            }
            out.push(this.evidenceFromTranscript(agentType, agentId, jsonl, request));
        }
        return out;
    }

    // eslint-disable-next-line @typescript-eslint/max-params
    private evidenceFromTranscript(agentType: string, agentId: string, jsonl: string, request: EvidenceRequest): ReviewerEvidence {
        const scan = this.scanTranscript(jsonl);
        const inputs = scan.inputs;
        const docPath = request.docPaths[agentType] ?? '';
        // The instructions file counts as "read the diff": it lives in the same per-branch dir, it is what
        // the reviewer is told to open first, and it inlines the diff paths. A reviewer that opened it and
        // then its own diff files is the intended path; treating only the diff dir as proof would flag it.
        const readDiff = request.diffDir !== '' && this.mentions(inputs, request.diffDir);
        return new ReviewerEvidence(
            agentType, agentId, readDiff,
            docPath !== '' && this.mentions(inputs, docPath),
            inputs.length,
            inputs.filter((i: string): boolean => i.includes('node_modules')).length,
            jsonl,
            scan.models,
        );
    }

    /**
     * Record this line's `message.model`, deduped, in first-seen order.
     *
     * `<synthetic>` records are SKIPPED. The harness writes them for messages no model produced (tool
     * results, injected notices); counting one would put a non-model in a field whose entire purpose is
     * "which model reviewed this", and it would show up on every single reviewer.
     */
    // webpieces-disable no-any-unknown -- opaque transcript record, only `model` is read and it is type-guarded below
    private collectModel(message: Record<string, unknown>, models: string[]): void {
        const model = message['model'];
        if (typeof model !== 'string' || model === '' || model === '<synthetic>') return;
        if (!models.includes(model)) models.push(model);
    }

    // The absolute path of agent-<id>.jsonl across all session dirs, or '' if it is not there.
    private transcriptPath(dirs: readonly string[], agentId: string): string {
        for (const dir of dirs) {
            const candidate = path.join(dir, `agent-${agentId}.jsonl`);
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
    }

    /**
     * ONE pass over the transcript for both answers (see {@link TranscriptScan}).
     *
     * Tool inputs are JSON-stringified rather than walked field-by-field because the shape differs per
     * tool (Read takes file_path, Bash takes command, Grep takes path) and a substring test over the
     * serialized input is both simpler and robust to a tool we have not seen.
     *
     * Best-effort, like everything else that parses this file: a format change must never wedge the
     * gate, so an unreadable transcript yields empty rather than throwing. That matters more for the
     * models than for the counters — this is quality telemetry, not an integrity check, and a missing
     * `model` field must not be able to block a PR.
     */
    private scanTranscript(jsonl: string): TranscriptScan {
        const scan = new TranscriptScan();
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable transcript yields no evidence, never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
                if (line.trim() === '') continue;
                const rec = this.parseLine(line);
                const message = rec?.['message'];
                if (typeof message !== 'object' || message === null) continue;
                // webpieces-disable no-any-unknown -- opaque transcript record, narrowed by the guard above
                const msg = message as Record<string, unknown>;
                this.collectModel(msg, scan.models);
                const content = msg['content'];
                if (!Array.isArray(content)) continue;
                for (const block of content) {
                    // webpieces-disable no-any-unknown -- opaque content block, only `type`/`input` are read
                    const b = block as Record<string, unknown>;
                    if (b['type'] === 'tool_use') scan.inputs.push(JSON.stringify(b['input'] ?? {}));
                }
            }
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
        return scan;
    }

    private mentions(inputs: readonly string[], needle: string): boolean {
        return inputs.some((i: string): boolean => i.includes(needle));
    }

    // Are we running under Claude Code at all? (CI / plain terminal → provenance is unverifiable → SKIP.)
    private inClaudeSession(): boolean {
        return (process.env['CLAUDE_CODE_SESSION_ID'] ?? '').trim() !== '';
    }

    private skipped(what: string): ProvenanceResult {
        return new ProvenanceResult(PROVENANCE_SKIPPED,
            `CLAUDE_CODE_SESSION_ID not set — cannot verify ${what} ran (plain terminal / CI). Skipping the provenance check.`);
    }

    // The agentId of a matching subagent run for `agentType` on `branch`, searched across ALL sessions'
    // subagent dirs (branch-scoped, so a run from a prior session still counts). '' if none. `exclude`
    // skips agentIds already credited to another checklist so one run can't satisfy two.
    private findMatchingAgentId(dirs: readonly string[], agentType: string, branch: string, exclude: ReadonlySet<string> = new Set()): string {
        for (const dir of dirs) {
            for (const metaFile of this.metaFiles(dir)) {
                const agentId = this.agentIdOf(metaFile);
                if (exclude.has(agentId)) continue;
                const meta = this.readJson(path.join(dir, metaFile));
                if (!meta || meta['agentType'] !== agentType) continue;
                const spawnDepth = meta['spawnDepth'];
                if (typeof spawnDepth !== 'number' || spawnDepth < 1) continue;
                if (this.sidechainOnBranch(dir, agentId, branch)) return agentId;
            }
        }
        return '';
    }

    // Every `projects/*/<session>/subagents` dir that exists — matching by the recorded gitBranch (not by
    // session id) is what makes provenance survive across sessions.
    private allSubagentsDirs(): string[] {
        const projects = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(projects)) return [];
        const out: string[] = [];
        for (const proj of this.readDir(projects)) {
            const projDir = path.join(projects, proj);
            for (const session of this.readDir(projDir)) {
                const candidate = path.join(projDir, session, 'subagents');
                if (fs.existsSync(candidate)) out.push(candidate);
            }
        }
        return out;
    }

    private metaFiles(dir: string): string[] {
        return this.readDir(dir).filter((f: string): boolean => f.endsWith('.meta.json'));
    }

    // agent-<id>.meta.json → <id>
    private agentIdOf(metaFile: string): string {
        return metaFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    }

    /**
     * Cross-check the sibling transcript's record 0: isSidechain true (a real subagent, not the main
     * loop) and the same branch. Lenient on branch drift (a leftover …wpN suffix from a mid-flight
     * branch rename) and on a missing jsonl (meta already matched — accept, best-effort).
     *
     * WHEN `gitBranch` DISAGREES, A PINNED `cwd` DECIDES. Record 0 carries both fields, and the harness
     * can write a `gitBranch` that CONTRADICTS the record's own `cwd`: a reviewer subagent spawned into
     * a worktree on `dean/one-2406-…` was stamped `worktree-agent-a54887200e40eb956` — an unrelated,
     * still-live worktree's scaffold branch — deterministically, on four consecutive attempts, blocking
     * a PR whose required reviewer genuinely ran and genuinely passed. `stripWp` cannot bridge that, so
     * the reviewer was never credited and `wp-finish-upsert-pr` refused a legitimately-reviewed PR with
     * no in-flow recovery. A sweep of 961 record-0s on one machine found the mis-stamp is the MAJORITY
     * case among subagents in dedicated worktrees, so trusting `gitBranch` alone can never be correct.
     *
     * ─── Why ONLY a linked worktree, and never the primary clone ──────────────────────────────────
     * "Ask git what branch the cwd is on" is correct only when that cwd CANNOT have moved since the
     * reviewer ran. A LINKED WORKTREE is 1:1 with the agent that owns it and nothing re-checks it out;
     * the PRIMARY CLONE gets checked out constantly. Falling back on a primary-clone cwd would credit a
     * STALE reviewer, and by construction rather than by accident:
     *
     *   1. a reviewer runs in the primary clone while it is on branch A
     *   2. the clone is later checked out to branch B
     *   3. `wp-finish-upsert-pr` runs on B — `gitBranch` (stamped A) mismatches
     *   4. `git -C <clone>` now answers B, because the CLONE moved → the reviewer is credited for B
     *
     * It reviewed A. Every past reviewer run in that clone would be credited for whatever branch is
     * checked out at finish time — which in a repo with a required reviewer on every PR is not an
     * exotic sequence, it is the normal one. So the fallback is gated on `dotWebpieces.isLinkedWorktree`
     * (git's own `--git-dir != --git-common-dir` test, reused rather than re-derived), and a primary
     * clone falls through to a refusal exactly as it does today.
     *
     * That gate keeps the anti-forgery property intact: `cwd` is harness-written in the same record by
     * the same writer as `gitBranch`, so it carries the same weight — and inside a pinned worktree it is
     * the field that is CORRECT. There is deliberately no config flag and no second comparison mode:
     * ONE rule, with `gitBranch` only ever a cheap way to skip the subprocess when it already agrees.
     *
     * An UNRESOLVABLE cwd does not credit either. A reaped worktree, a deleted directory, a non-repo
     * path or a detached HEAD yields '' and falls through to a refusal. Leniency here is bounded by
     * "git can still prove it", never by "we could not check, so assume yes".
     */
    private sidechainOnBranch(dir: string, agentId: string, branch: string): boolean {
        const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
        if (!fs.existsSync(jsonl)) return true;
        const first = this.firstNonEmptyLine(jsonl);
        if (first === '') return true;
        const rec = this.parseLine(first);
        if (!rec) return true;
        if (rec['isSidechain'] !== true) return false;
        const gitBranch = rec['gitBranch'];
        // Not recorded at all → accept, as before: nothing to contradict and nothing to verify against.
        if (typeof gitBranch !== 'string' || gitBranch === '') return true;
        const want = this.stripWp(branch);
        if (this.stripWp(gitBranch) === want) return true;
        return want !== '' && this.stripWp(this.branchOfCwd(rec['cwd'])) === want;
    }

    /**
     * The branch record-0's own `cwd` is PINNED to, '' when that cannot be established or is not pinned.
     *
     * Cached per cwd because `findMatchingAgentId` walks every subagent of every session on the machine
     * and several of them share a worktree — one `git` process per RECORD would put dozens of spawns on
     * the path that opens a PR.
     */
    // webpieces-disable no-any-unknown -- one opaque record field, type-guarded on the next line
    private branchOfCwd(cwd: unknown): string {
        if (typeof cwd !== 'string' || cwd === '') return '';
        const cached = this.branchByCwd.get(cwd);
        if (cached !== undefined) return cached;
        const resolved = this.pinnedBranch(cwd);
        this.branchByCwd.set(cwd, resolved);
        return resolved;
    }

    /**
     * The branch of `cwd` when — and only when — `cwd` is a LINKED WORKTREE. '' otherwise.
     *
     * '' for the primary clone (it moves; see sidechainOnBranch for the false-accept that closes), for a
     * reaped or deleted directory, for a non-repo path, when git is unavailable, and for a detached HEAD,
     * which `--abbrev-ref` prints as the literal `HEAD` and which names no branch.
     */
    private pinnedBranch(cwd: string): string {
        if (!fs.existsSync(cwd)) return '';
        if (!dotWebpieces.isLinkedWorktree(cwd)) return '';
        const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
        if (result.status !== 0) return '';
        const printed = (result.stdout ?? '').trim();
        return printed === 'HEAD' ? '' : printed;
    }

    private stripWp(branch: string): string {
        return branch.replace(/-?wp\d+$/i, '');
    }

    private readDir(dir: string): string[] {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable dir yields [] (best-effort provenance)
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readdirSync(dir);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    private firstNonEmptyLine(filePath: string): string {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: unreadable transcript → '' (best-effort)
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
                if (line.trim() !== '') return line;
            }
            return '';
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON object, keys read by the caller
    private readJson(filePath: string): Record<string, unknown> | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: malformed meta.json → null (skipped)
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

    // webpieces-disable no-any-unknown -- one opaque JSONL record, keys read by the caller
    private parseLine(line: string): Record<string, unknown> | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: malformed JSONL record → null
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed by the caller
            return JSON.parse(line) as Record<string, unknown>;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }
}
