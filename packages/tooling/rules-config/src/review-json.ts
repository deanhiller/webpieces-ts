import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { WEBPIECES_TMP_DIR, PR_REVIEW_DIR } from './constants';
import { CHECKLIST_BLOCK } from './checklist-config';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

// One entry the AI writes into review.json's `checklists[]`: "I read the doc for <id> and walked it".
// acknowledged: true is the AI attesting it did the walk — a SURFACING/AUDIT signal, not authorization.
export class ChecklistAck {
    id: string;
    acknowledged: boolean;
    notes: string[]; // per-item findings the AI chose to record (optional; [] when none)

    constructor(id: string, acknowledged: boolean, notes: string[]) {
        this.id = id;
        this.acknowledged = acknowledged;
        this.notes = notes;
    }
}

// The verdict a reviewer wrote into a PER-CHECKLIST file `.webpieces/pr-review/<branch>/review-<id>.json`,
// one per triggered checklist. Replaces the single shared `checklists[]` array so concurrent reviewer
// subagents never clobber one file. Unlike ChecklistAck's bare boolean, this records the OUTCOME:
//   success:true                       → PASS
//   success:false + override non-empty → OVERRIDDEN (pass; the free-text justification reaches the PR)
//   success:false + no override        → FAIL (refuse; `output` is printed verbatim)
// `override` is deliberately free text, not a boolean — it forces the bypass to be stated in words and
// surfaces it on the dashboard, where a human sees it. Data-only (per CLAUDE.md).
export class ChecklistResult {
    id: string;
    success: boolean;
    output: string;   // what the reviewer found; printed verbatim when a BLOCK checklist fails
    override: string;  // '' = no override; non-empty = ship-anyway justification (renders 🟡 overridden)

    constructor(id: string, success: boolean, output: string, override: string) {
        this.id = id;
        this.success = success;
        this.output = output;
        this.override = override;
    }
}

// What the CALLER (the pr-gate command) computed from the diff: the checklists this branch triggered.
// Drives BOTH review.json validation (BLOCK must be acknowledged) AND the printed schema hint (so the
// AI is told, at the moment it writes review.json, exactly which docs to read). Data-only.
export class RequiredChecklist {
    id: string;
    title: string;
    severity: string; // 'BLOCK' | 'WARN'
    docs: string[];
    blockMessage: string;
    matchedFiles: string[]; // the changed files that triggered it (for the dashboard + hint)
    subagent: string; // expected reviewer agentType ('' = no provenance requirement); enforced by finish

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, title: string, severity: string, docs: string[], blockMessage: string, matchedFiles: string[], subagent = '') {
        this.id = id;
        this.title = title;
        this.severity = severity;
        this.docs = docs;
        this.blockMessage = blockMessage;
        this.matchedFiles = matchedFiles;
        this.subagent = subagent;
    }
}

// The AI-authored review for a PR. The AI writes this file itself between `wp-start-upsert-pr` (which
// prints the schema) and `wp-finish-upsert-pr` (which reads it). Data-only (per CLAUDE.md).
export class ReviewJson {
    title: string; // human PR title describing the change; used as the `gh pr` title (empty → caller falls back)
    riskScore: number; // 0–100, drives the risk bar
    riskLevel: string; // 'green' | 'yellow' | 'red'
    riskEmoji: string; // '🟢' | '🟡' | '🔴' — derived from riskLevel when omitted
    summary: string; // rendered in the dashboard Summary section
    violations: string[]; // pattern/architecture violations; length = the Pattern Violations count
    risks: string[];
    filesToReview: string[];
    checklists: ChecklistAck[]; // legacy inline acknowledgments (back-compat); [] when none written
    results: ChecklistResult[]; // resolved per-checklist verdicts (from review-<id>.json); [] when none

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        title: string,
        riskScore: number,
        riskLevel: string,
        riskEmoji: string,
        summary: string,
        violations: string[],
        risks: string[],
        filesToReview: string[],
        checklists: ChecklistAck[] = [],
        results: ChecklistResult[] = [],
    ) {
        this.title = title;
        this.riskScore = riskScore;
        this.riskLevel = riskLevel;
        this.riskEmoji = riskEmoji;
        this.summary = summary;
        this.violations = violations;
        this.risks = risks;
        this.filesToReview = filesToReview;
        this.checklists = checklists;
        this.results = results;
    }
}

// A checklist's resolved outcome, shared by review.json enforcement and the dashboard so both agree.
export const CK_PASS = 'pass';               // review-<id>.json success:true
export const CK_OVERRIDDEN = 'overridden';   // review-<id>.json success:false + non-empty override → 🟡
export const CK_FAIL = 'fail';               // review-<id>.json success:false + no override → refuse
export const CK_MISSING = 'missing';         // no verdict file and no inline ack → refuse (BLOCK)
export const CK_ACKED = 'acknowledged';      // legacy inline checklists[] ack satisfied (back-compat)

export class ChecklistVerdict {
    id: string;
    status: string; // one of CK_PASS | CK_OVERRIDDEN | CK_FAIL | CK_MISSING | CK_ACKED
    detail: string; // reviewer output / override justification / ack notes (for the dashboard + errors)

    constructor(id: string, status: string, detail: string) {
        this.id = id;
        this.status = status;
        this.detail = detail;
    }
}

const RISK_LEVELS = ['green', 'yellow', 'red'] as const;
const EMOJI_FOR_LEVEL: Record<string, string> = { green: '🟢', yellow: '🟡', red: '🔴' };

/** Locates + loads/validates the AI-authored review.json. `@injectable(bindingScopeValues.Singleton)` so it's drawn in the design. */
@injectable(bindingScopeValues.Singleton)
export class ReviewJsonService {
    // The per-feature PR working dir: `.webpieces/pr-review/<feature>`.
    prDirFor(repoRoot: string, featureName: string): string {
        return path.join(repoRoot, WEBPIECES_TMP_DIR, PR_REVIEW_DIR, featureName);
    }

    // Absolute path of the review.json for a feature — beside pr-body.md, keyed by branch name.
    reviewJsonPath(repoRoot: string, featureName: string): string {
        return path.join(this.prDirFor(repoRoot, featureName), 'review.json');
    }

    // Copy-paste schema both commands print (write it / fix it). `required` is the set of consumer
    // checklists the diff triggered; when it is empty the output is byte-identical to before this
    // feature existed (non-adopting repos see no change). When non-empty it grows a `checklists` line
    // in the JSON shape PLUS an instruction block naming the docs to read — diff-derived instructions
    // injected at exactly the moment the AI writes review.json.
    reviewJsonSchemaHint(filePath: string, required: readonly RequiredChecklist[] = []): string {
        return (
            `Write your PR review to:\n  ${filePath}\n\n` +
            `with this exact JSON shape (riskEmoji optional — derived from riskLevel):\n\n` +
            `{\n` +
            `  "title": "concise PR title describing the change (imperative, no branch names)",\n` +
            `  "riskScore": 0,                       // integer 0–100 (higher = riskier)\n` +
            `  "riskLevel": "green | yellow | red",\n` +
            `  "summary": "5–10 sentence review summary",\n` +
            `  "violations": ["pattern/architecture violations you found (empty array if none)"],\n` +
            `  "risks": ["notable risks (empty array if none)"],\n` +
            `  "filesToReview": ["paths a human should look at (empty array if none)"]\n` +
            `}` +
            this.requiredChecklistHint(filePath, required)
        );
    }

    // The per-checklist review file path that sits beside review.json: review-<id>.json.
    checklistResultPath(reviewJsonFilePath: string, checklistId: string): string {
        return path.join(path.dirname(reviewJsonFilePath), `review-${checklistId}.json`);
    }

    // The diff-triggered instruction block, appended ONLY when the branch triggered a checklist. This is
    // the consumer's review process, re-injected: read doc Y because the diff touched X, then write ONE
    // file per checklist — `review-<id>.json` — so concurrent reviewer subagents never clobber a shared
    // file. A BLOCK checklist with success:false and no override refuses to open the PR.
    private requiredChecklistHint(reviewJsonFilePath: string, required: readonly RequiredChecklist[]): string {
        if (required.length === 0) return '';
        const lines: string[] = ['', '', 'This branch triggered company review checklist(s). For EACH one below: READ its docs, walk'];
        lines.push('the items against your diff, then write a SEPARATE file `review-<id>.json` beside review.json');
        lines.push('with this shape (override optional — a free-text ship-anyway justification):');
        lines.push('');
        lines.push('  { "success": true, "output": "what you checked / what you found", "override": "" }');
        lines.push('');
        for (const req of required) {
            const gate = req.severity === CHECKLIST_BLOCK
                ? 'BLOCK — success:false with no "override" will NOT open the PR'
                : 'WARN — recorded on the dashboard; never blocks';
            lines.push(`  • [${req.id}] ${req.title} (${gate})`);
            lines.push(`      write: ${this.checklistResultPath(reviewJsonFilePath, req.id)}`);
            lines.push(`      docs to read: ${req.docs.join(', ')}`);
            if (req.subagent.trim() !== '') lines.push(`      must be reviewed by the "${req.subagent.trim()}" subagent (its independent run is verified from the harness).`);
            if (req.blockMessage.trim() !== '') lines.push(`      ${req.blockMessage.trim()}`);
            if (req.matchedFiles.length > 0) lines.push(`      triggered by: ${req.matchedFiles.slice(0, 5).join(', ')}`);
        }
        return lines.join('\n');
    }

    /**
     * Load + validate the AI-authored review.json. Throws InformAiError (with the schema) when missing,
     * unparseable, or structurally wrong. Returns a fully-populated ReviewJson on success.
     *
     * `required` is the set of consumer checklists the diff triggered (empty for non-adopting repos, in
     * which case this behaves byte-identically to before the feature). Every BLOCK entry must appear in
     * review.json's `checklists[]` with `acknowledged: true`, or a validation error is raised alongside
     * the usual ones so the AI gets ONE message. WARN entries are never validated; unknown ids in
     * `checklists[]` are ignored (forward-compat).
     */
    // webpieces-disable max-lines-new-methods -- one cohesive load+validate pass over the review fields
    loadReviewJson(filePath: string, required: readonly RequiredChecklist[] = []): ReviewJson {
        if (!fs.existsSync(filePath)) {
            throw new InformAiError(
                `Required review.json not found.\n\n${this.reviewJsonSchemaHint(filePath, required)}\n\n` +
                `Then re-run: pnpm wp-finish-upsert-pr`,
            );
        }

        const raw = this.parseReviewJson(fs.readFileSync(filePath, 'utf8'), filePath, required);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new InformAiError(`review.json must be a JSON object.\n\n${this.reviewJsonSchemaHint(filePath, required)}`);
        }

        const errors: string[] = [];

        const riskScore = raw['riskScore'];
        if (typeof riskScore !== 'number' || !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
            errors.push(`"riskScore" must be a number 0–100, got ${JSON.stringify(riskScore)}.`);
        }

        const riskLevel = raw['riskLevel'];
        if (typeof riskLevel !== 'string' || !RISK_LEVELS.includes(riskLevel as typeof RISK_LEVELS[number])) {
            errors.push(`"riskLevel" must be one of: ${RISK_LEVELS.join(', ')}.`);
        }

        const title = typeof raw['title'] === 'string' ? (raw['title'] as string).trim() : '';
        if (title === '') {
            errors.push('"title" must be a non-empty, imperative PR title describing the change (no branch names).');
        }

        const acks = this.parseChecklistAcks(raw['checklists']);
        const results = this.loadChecklistResults(filePath, required);
        for (const err of this.requiredChecklistErrors(required, acks, results)) errors.push(err);

        if (errors.length > 0) {
            throw new InformAiError(
                `review.json has ${errors.length} error(s) — fix ALL, then re-run pnpm wp-finish-upsert-pr:\n\n` +
                errors.map((e: string): string => `  • ${e}`).join('\n') +
                `\n\n${this.reviewJsonSchemaHint(filePath, required)}`,
            );
        }

        const level = riskLevel as string;
        const emoji = typeof raw['riskEmoji'] === 'string' && raw['riskEmoji'] !== ''
            ? (raw['riskEmoji'] as string)
            : (EMOJI_FOR_LEVEL[level] ?? '🟡');
        const summary = typeof raw['summary'] === 'string' ? (raw['summary'] as string) : '';

        return new ReviewJson(
            title,
            riskScore as number,
            level,
            emoji,
            summary,
            this.asStringArray(raw['violations']),
            this.asStringArray(raw['risks']),
            this.asStringArray(raw['filesToReview']),
            acks,
            results,
        );
    }

    // Parse the AI-authored `checklists[]` into typed ChecklistAck[]. Tolerant of a missing/garbage
    // field (→ []) and of non-object entries (skipped) — malformed acks simply fail to satisfy a BLOCK
    // requirement rather than crashing the load.
    // webpieces-disable no-any-unknown -- opaque parsed JSON value, narrowed here
    private parseChecklistAcks(value: unknown): ChecklistAck[] {
        if (!Array.isArray(value)) return [];
        const acks: ChecklistAck[] = [];
        for (const entry of value) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
            // webpieces-disable no-any-unknown -- one opaque ack entry, narrowed field-by-field
            const e = entry as Record<string, unknown>;
            const id = typeof e['id'] === 'string' ? (e['id'] as string) : '';
            if (id === '') continue;
            acks.push(new ChecklistAck(id, e['acknowledged'] === true, this.asStringArray(e['notes'])));
        }
        return acks;
    }

    // Read the per-checklist verdict files `review-<id>.json` that sit beside review.json — one per
    // triggered checklist. Tolerant like parseChecklistAcks: a missing file is simply absent from the
    // result (→ falls back to the inline ack / counts as unmet for a BLOCK), and a malformed one is
    // skipped (an unknown/stale review-<id>.json never wedges the branch).
    loadChecklistResults(reviewJsonFilePath: string, required: readonly RequiredChecklist[]): ChecklistResult[] {
        const results: ChecklistResult[] = [];
        for (const req of required) {
            const p = this.checklistResultPath(reviewJsonFilePath, req.id);
            if (!fs.existsSync(p)) continue;
            const parsed = this.parseChecklistResult(p, req.id);
            if (parsed) results.push(parsed);
        }
        return results;
    }

    // Resolve ONE checklist's verdict from its per-file result (preferred) or its legacy inline ack.
    // Central so review.json enforcement AND the finish-command dashboard agree on the outcome.
    resolveVerdict(req: RequiredChecklist, acks: readonly ChecklistAck[], results: readonly ChecklistResult[]): ChecklistVerdict {
        const result = results.find((r: ChecklistResult): boolean => r.id === req.id);
        if (result) {
            if (result.success) return new ChecklistVerdict(req.id, CK_PASS, result.output);
            if (result.override.trim() !== '') return new ChecklistVerdict(req.id, CK_OVERRIDDEN, result.override.trim());
            return new ChecklistVerdict(req.id, CK_FAIL, result.output);
        }
        const ack = acks.find((a: ChecklistAck): boolean => a.id === req.id);
        if (ack && ack.acknowledged) return new ChecklistVerdict(req.id, CK_ACKED, ack.notes.join('; '));
        return new ChecklistVerdict(req.id, CK_MISSING, '');
    }

    // BLOCK requirements whose verdict is FAIL (reviewed, found a problem, no override) or MISSING (no
    // verdict written at all) → one error each. WARN never blocks. Uses the consumer's blockMessage /
    // the reviewer's `output` verbatim so the consumer owns the wording and webpieces owns the mechanism.
    private requiredChecklistErrors(required: readonly RequiredChecklist[], acks: readonly ChecklistAck[], results: readonly ChecklistResult[]): string[] {
        const errors: string[] = [];
        for (const req of required) {
            if (req.severity !== CHECKLIST_BLOCK) continue;
            const verdict = this.resolveVerdict(req, acks, results);
            if (verdict.status === CK_FAIL) {
                const msg = req.blockMessage.trim() !== '' ? `${req.blockMessage.trim()} ` : '';
                errors.push(
                    `Checklist "${req.id}" (${req.title}) FAILED review. ${msg}` +
                    `The reviewer wrote:\n      ${verdict.detail.split('\n').join('\n      ')}\n` +
                    `      Fix it, then re-run; or set a non-empty "override" in ${this.checklistFileName(req.id)} to ship anyway with a stated justification.`,
                );
            } else if (verdict.status === CK_MISSING) {
                const docs = req.docs.length > 0 ? ` Read: ${req.docs.join(', ')}.` : '';
                const msg = req.blockMessage.trim() !== '' ? `${req.blockMessage.trim()} ` : '';
                errors.push(
                    `Checklist "${req.id}" (${req.title}) is REQUIRED for this diff but has no verdict. ${msg}` +
                    `Write ${this.checklistFileName(req.id)} with {"success":true,"output":"…"} once you have walked it.${docs}`,
                );
            }
        }
        return errors;
    }

    private checklistFileName(checklistId: string): string {
        return `review-${checklistId}.json`;
    }

    // Parse one review-<id>.json into a ChecklistResult, or null when malformed. Tolerant: missing
    // `success` counts as false (fail-closed), `output`/`override` default to ''.
    // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed field-by-field
    private parseChecklistResult(filePath: string, id: string): ChecklistResult | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a malformed per-checklist file is skipped, not fatal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed below
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
            const success = raw['success'] === true;
            const output = typeof raw['output'] === 'string' ? (raw['output'] as string) : '';
            const override = typeof raw['override'] === 'string' ? (raw['override'] as string) : '';
            return new ChecklistResult(id, success, output, override);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON value, narrowed to string[] here
    private asStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) return [];
        // webpieces-disable no-any-unknown -- element of an opaque JSON array, narrowed by the type guard
        return value.filter((v: unknown): v is string => typeof v === 'string');
    }

    // Parse opaque AI-authored JSON, converting a SyntaxError into a readable InformAiError. `required`
    // is threaded through so a JSON syntax error still prints the checklist instructions the AI needs —
    // exactly when it most needs them — rather than the bare schema.
    // webpieces-disable no-any-unknown -- returns the opaque parsed object; loadReviewJson narrows each field
    private parseReviewJson(raw: string, filePath: string, required: readonly RequiredChecklist[]): Record<string, unknown> {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: convert JSON.parse SyntaxError to an InformAiError for the AI
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed by the caller
            return JSON.parse(raw) as Record<string, unknown>;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `review.json is not valid JSON (${error.message}).\n\n${this.reviewJsonSchemaHint(filePath, required)}\n\n` +
                `Then re-run: pnpm wp-finish-upsert-pr`,
            );
        }
    }
}

// Temporary migration delegators to ReviewJsonService — removed once consumers inject it.
const reviewJsonSvc = new ReviewJsonService();

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function prDirFor(repoRoot: string, featureName: string): string {
    return reviewJsonSvc.prDirFor(repoRoot, featureName);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function reviewJsonPath(repoRoot: string, featureName: string): string {
    return reviewJsonSvc.reviewJsonPath(repoRoot, featureName);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function reviewJsonSchemaHint(filePath: string, required: readonly RequiredChecklist[] = []): string {
    return reviewJsonSvc.reviewJsonSchemaHint(filePath, required);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function loadReviewJson(filePath: string, required: readonly RequiredChecklist[] = []): ReviewJson {
    return reviewJsonSvc.loadReviewJson(filePath, required);
}
