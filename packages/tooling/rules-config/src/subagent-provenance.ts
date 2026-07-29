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
        const sessionId = process.env['CLAUDE_CODE_SESSION_ID'] ?? '';
        if (sessionId.trim() === '') {
            return new ProvenanceResult(PROVENANCE_SKIPPED,
                `CLAUDE_CODE_SESSION_ID not set — cannot verify the "${expectedAgentType}" reviewer subagent (plain terminal / CI). Skipping the provenance check.`);
        }
        const dir = this.findSubagentsDir(sessionId);
        if (dir === '') {
            return new ProvenanceResult(PROVENANCE_MISSING,
                `No subagents recorded for this session — the "${expectedAgentType}" reviewer subagent must run on this branch before the PR can open.`);
        }
        for (const metaFile of this.metaFiles(dir)) {
            const meta = this.readJson(path.join(dir, metaFile));
            if (!meta) continue;
            if (meta['agentType'] !== expectedAgentType) continue;
            const spawnDepth = meta['spawnDepth'];
            if (typeof spawnDepth !== 'number' || spawnDepth < 1) continue;
            const agentId = this.agentIdOf(metaFile);
            if (this.sidechainOnBranch(dir, agentId, branch)) {
                return new ProvenanceResult(PROVENANCE_OK,
                    `verified "${expectedAgentType}" reviewer subagent ran (agent ${agentId}).`);
            }
        }
        return new ProvenanceResult(PROVENANCE_MISSING,
            `No "${expectedAgentType}" reviewer subagent ran on this branch — a separate reviewer of that type must review this checklist.`);
    }

    // Find the subagents dir for `sessionId` by its UNIQUE id, so the cwd-slug never has to be guessed.
    private findSubagentsDir(sessionId: string): string {
        const projects = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(projects)) return '';
        for (const proj of this.readDir(projects)) {
            const candidate = path.join(projects, proj, sessionId, 'subagents');
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
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
