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

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, title: string, severity: string, docs: string[], blockMessage: string, matchedFiles: string[]) {
        this.id = id;
        this.title = title;
        this.severity = severity;
        this.docs = docs;
        this.blockMessage = blockMessage;
        this.matchedFiles = matchedFiles;
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
    checklists: ChecklistAck[]; // consumer-checklist acknowledgments; [] when no checklists were required

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
        const checklistLine = required.length > 0
            ? `,\n  "checklists": [{ "id": "<id from the list below>", "acknowledged": true, "notes": ["what you checked"] }]\n`
            : `\n`;
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
            `  "filesToReview": ["paths a human should look at (empty array if none)"]` +
            checklistLine +
            `}` +
            this.requiredChecklistHint(required)
        );
    }

    // The diff-triggered instruction block, appended ONLY when the branch triggered a checklist. This
    // is the consumer's review process, re-injected: read doc Y because the diff touched X. BLOCK
    // entries must be acknowledged in `checklists[]` or wp-finish-upsert-pr refuses to open the PR.
    private requiredChecklistHint(required: readonly RequiredChecklist[]): string {
        if (required.length === 0) return '';
        const lines: string[] = ['', '', 'This branch triggered company review checklist(s). BEFORE writing review.json, READ each'];
        lines.push('doc, walk its items against your diff, then add a `checklists[]` entry acknowledging it:');
        lines.push('');
        for (const req of required) {
            const gate = req.severity === CHECKLIST_BLOCK
                ? 'BLOCK — the PR will NOT open until you acknowledge it'
                : 'WARN — acknowledge if it applies (never blocks)';
            lines.push(`  • [${req.id}] ${req.title} (${gate})`);
            lines.push(`      docs to read: ${req.docs.join(', ')}`);
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

        const raw = this.parseReviewJson(fs.readFileSync(filePath, 'utf8'), filePath);
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
        for (const err of this.requiredChecklistErrors(required, acks)) errors.push(err);

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

    // BLOCK requirements that are not acknowledged → one error each, using the consumer's blockMessage
    // verbatim so the consumer owns the wording and webpieces owns the mechanism.
    private requiredChecklistErrors(required: readonly RequiredChecklist[], acks: readonly ChecklistAck[]): string[] {
        const errors: string[] = [];
        for (const req of required) {
            if (req.severity !== CHECKLIST_BLOCK) continue;
            const ack = acks.find((a: ChecklistAck): boolean => a.id === req.id);
            if (!ack || !ack.acknowledged) {
                const docs = req.docs.length > 0 ? ` Read: ${req.docs.join(', ')}.` : '';
                const msg = req.blockMessage.trim() !== '' ? `${req.blockMessage.trim()} ` : '';
                errors.push(
                    `Checklist "${req.id}" (${req.title}) is REQUIRED for this diff but not acknowledged. ${msg}` +
                    `Add {"id":"${req.id}","acknowledged":true,"notes":[...]} to "checklists" once you have walked it.${docs}`,
                );
            }
        }
        return errors;
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON value, narrowed to string[] here
    private asStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) return [];
        // webpieces-disable no-any-unknown -- element of an opaque JSON array, narrowed by the type guard
        return value.filter((v: unknown): v is string => typeof v === 'string');
    }

    // Parse opaque AI-authored JSON, converting a SyntaxError into a readable InformAiError.
    // webpieces-disable no-any-unknown -- returns the opaque parsed object; loadReviewJson narrows each field
    private parseReviewJson(raw: string, filePath: string): Record<string, unknown> {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: convert JSON.parse SyntaxError to an InformAiError for the AI
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed by the caller
            return JSON.parse(raw) as Record<string, unknown>;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `review.json is not valid JSON (${error.message}).\n\n${this.reviewJsonSchemaHint(filePath)}\n\n` +
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
