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

    constructor(status: string, detail: string) {
        this.status = status;
        this.detail = detail;
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
        for (const type of expectedAgentTypes) {
            const agentId = this.findMatchingAgentId(dirs, type, branch, usedAgentIds);
            if (agentId === '') missing.push(type);
            else usedAgentIds.add(agentId);
        }
        return missing.length === 0
            ? new ProvenanceResult(PROVENANCE_OK, `verified ${expectedAgentTypes.length} distinct reviewer subagent(s) ran`)
            : new ProvenanceResult(PROVENANCE_MISSING,
                `these reviewer subagents did not run on this branch (spawn each as its OWN subagent — do not self-certify): ${missing.join(', ')}`);
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
