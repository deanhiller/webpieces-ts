import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { injectable, bindingScopeValues } from 'inversify';
import { toError } from './to-error';

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

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(agentType: string, agentId: string, readDiff = false, readDoc = false, toolCallCount = 0, offRepoSearches = 0) {
        this.agentType = agentType;
        this.agentId = agentId;
        this.readDiff = readDiff;
        this.readDoc = readDoc;
        this.toolCallCount = toolCallCount;
        this.offRepoSearches = offRepoSearches;
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
        const inputs = this.toolInputsOf(jsonl);
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
        );
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
     * Every tool_use input in a transcript, JSON-stringified. Stringified rather than walked field-by-field
     * because the shape differs per tool (Read takes file_path, Bash takes command, Grep takes path) and a
     * substring test over the serialized input is both simpler and robust to a tool we have not seen.
     */
    private toolInputsOf(jsonl: string): string[] {
        const out: string[] = [];
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable transcript yields no evidence, never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
                if (line.trim() === '') continue;
                const rec = this.parseLine(line);
                const message = rec?.['message'];
                if (typeof message !== 'object' || message === null) continue;
                // webpieces-disable no-any-unknown -- opaque transcript record, narrowed by the guard above
                const content = (message as Record<string, unknown>)['content'];
                if (!Array.isArray(content)) continue;
                for (const block of content) {
                    // webpieces-disable no-any-unknown -- opaque content block, only `type`/`input` are read
                    const b = block as Record<string, unknown>;
                    if (b['type'] === 'tool_use') out.push(JSON.stringify(b['input'] ?? {}));
                }
            }
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
        return out;
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

    // Cross-check the sibling transcript's record 0: isSidechain true (a real subagent, not the main
    // loop) and, when recorded, the same branch. Lenient on branch drift (a leftover …wpN suffix from a
    // mid-flight branch rename) and on a missing jsonl (meta already matched — accept, best-effort).
    private sidechainOnBranch(dir: string, agentId: string, branch: string): boolean {
        const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
        if (!fs.existsSync(jsonl)) return true;
        const first = this.firstNonEmptyLine(jsonl);
        if (first === '') return true;
        const rec = this.parseLine(first);
        if (!rec) return true;
        if (rec['isSidechain'] !== true) return false;
        const gitBranch = rec['gitBranch'];
        if (typeof gitBranch !== 'string' || gitBranch === '') return true;
        return this.stripWp(gitBranch) === this.stripWp(branch);
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
