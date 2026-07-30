import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { WEBPIECES_TMP_DIR, PR_REVIEW_DIR } from './constants';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

// The verdict a reviewer SUBAGENT writes into `.webpieces/pr-review/<branch>/review-<id>.json`, one per
// matched checklist. One file per checklist so N concurrent reviewer subagents never clobber a shared
// file. It records the OUTCOME:
//   success:true                       → PASS
//   success:false + override non-empty → OVERRIDDEN (pass; the free-text justification reaches the PR)
//   success:false + no override        → FAIL (refuse; `output` is printed verbatim)
// `override` is deliberately free text, not a boolean — it forces the ship-anyway decision to be stated
// in words and surfaces it on the dashboard, where a human sees it. Data-only (per CLAUDE.md).
export class ChecklistResult {
    id: string;
    success: boolean;
    output: string;   // what the reviewer found; printed verbatim when the checklist fails
    override: string;  // '' = no override; non-empty = ship-anyway justification (renders 🟡 overridden)

    constructor(id: string, success: boolean, output: string, override: string) {
        this.id = id;
        this.success = success;
        this.output = output;
        this.override = override;
    }
}

// What the pr-gate command computed from the diff: a checklist this branch MATCHED (its patterns hit the
// diff, so its reviewer subagent must run). Drives review-<id>.json enforcement, provenance, the schema
// hint, and the dashboard. Data-only.
export class RequiredChecklist {
    id: string;             // = subagent name; keys review-<id>.json
    subagent: string;       // reviewer agent that must run (agentType the harness stamps)
    doc: string;            // REPO-RELATIVE guidance doc the reviewer reads ('' → it reads the manifest doc)
    matchedFiles: string[]; // the changed files that matched it (for the dashboard + hint)
    // Which of the checklist's OWN globs actually fired. Printed so a reviewer can judge how coarse the
    // match was — a precise `db/migrations/**` hit means something different from a blanket `**` — and the
    // template tells reviewers that matching IS deliberately coarse. [] = no patterns (matches every PR).
    matchedPatterns: string[];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, subagent: string, doc: string, matchedFiles: string[], matchedPatterns: string[] = []) {
        this.id = id;
        this.subagent = subagent;
        this.doc = doc;
        this.matchedFiles = matchedFiles;
        this.matchedPatterns = matchedPatterns;
    }
}

/**
 * The per-PR facts every reviewer subagent needs GIVEN to it, alongside its own checklist: the exact base
 * sha the gate diffs against and the file holding the complete changed-file set. Both used to live only in
 * a doc the printed instruction told the AI to go read, one indirection away from the instruction to hand
 * them over — so the printed block could not stand on its own. Data-only; empty = omit those lines.
 */
export class ChecklistReviewContext {
    baseSha: string;        // the 3-point merge-base sha; `git diff <baseSha> HEAD -- <file>`
    prContextPath: string;  // path of pr-context.json — the AUTHORITATIVE full changed-file set

    constructor(baseSha = '', prContextPath = '') {
        this.baseSha = baseSha;
        this.prContextPath = prContextPath;
    }
}

// The AI-authored review for a PR. The AI writes review.json itself between `wp-start-upsert-pr` (which
// prints the schema) and `wp-finish-upsert-pr` (which reads it); reviewer subagents write the per-checklist
// review-<id>.json files. Data-only (per CLAUDE.md).
export class ReviewJson {
    title: string; // human PR title describing the change; used as the `gh pr` title (empty → caller falls back)
    riskScore: number; // 0–100, drives the risk bar
    riskLevel: string; // 'green' | 'yellow' | 'red'
    riskEmoji: string; // '🟢' | '🟡' | '🔴' — derived from riskLevel when omitted
    summary: string; // rendered in the dashboard Summary section
    violations: string[]; // pattern/architecture violations; length = the Pattern Violations count
    risks: string[];
    filesToReview: string[];
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
        this.results = results;
    }
}

// A checklist's resolved outcome, shared by review.json enforcement and the dashboard so both agree.
export const CK_PASS = 'pass';               // review-<id>.json success:true
export const CK_OVERRIDDEN = 'overridden';   // review-<id>.json success:false + non-empty override → 🟡
export const CK_FAIL = 'fail';               // review-<id>.json success:false + no override → refuse
export const CK_MISSING = 'missing';         // no review-<id>.json written → refuse

export class ChecklistVerdict {
    id: string;
    status: string; // one of CK_PASS | CK_OVERRIDDEN | CK_FAIL | CK_MISSING
    detail: string; // reviewer output / override justification (for the dashboard + errors)

    constructor(id: string, status: string, detail: string) {
        this.id = id;
        this.status = status;
        this.detail = detail;
    }
}

// The PR's diff context, written by wp-start-upsert-pr into `.webpieces/pr-review/<branch>/pr-context.json`
// so a reviewer subagent knows the exact 3-point base the gate used and the full changed-file set — then
// reads any file's actual diff with `git diff <base> HEAD -- <file>`. This is what lets a checklist match
// coarsely by path (in the manifest) while the subagent makes the fine, content-level judgment. Data-only.
export class PrContext {
    base: string;          // the 3-point merge-base sha the gate diffs against
    head: string;          // HEAD sha
    changedFiles: string[]; // every file changed base..head (NOT tsOnly — includes .sql/.gql/Dockerfile/…)

    constructor(base: string, head: string, changedFiles: string[]) {
        this.base = base;
        this.head = head;
        this.changedFiles = changedFiles;
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

    // Absolute path of the pr-context.json for a feature (the diff base/head + changed files).
    prContextPath(repoRoot: string, featureName: string): string {
        return path.join(this.prDirFor(repoRoot, featureName), 'pr-context.json');
    }

    // Persist the PR's diff context so reviewer subagents can read the changed-file set + the exact base
    // sha (then `git diff <base> HEAD -- <file>` for content). Returns the file path written.
    writePrContext(repoRoot: string, featureName: string, context: PrContext): string {
        const dir = this.prDirFor(repoRoot, featureName);
        fs.mkdirSync(dir, { recursive: true });
        const p = this.prContextPath(repoRoot, featureName);
        fs.writeFileSync(p, JSON.stringify(context, null, 2) + '\n');
        return p;
    }

    /**
     * The review context for a feature, recovered from the pr-context.json wp-start-upsert-pr already wrote.
     * Lets wp-finish-upsert-pr's "you still owe me review-<id>.json" message inline the SAME self-sufficient
     * per-reviewer block start printed, instead of a checklist name and an indirection. Empty when the file
     * is absent or unreadable — the block then just omits those lines.
     */
    reviewContextFor(repoRoot: string, featureName: string): ChecklistReviewContext {
        const p = this.prContextPath(repoRoot, featureName);
        if (!fs.existsSync(p)) return new ChecklistReviewContext();
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable context file degrades to fewer printed lines, never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed on the next line
            const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
            const base = typeof raw['base'] === 'string' ? (raw['base'] as string) : '';
            return new ChecklistReviewContext(base, p);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return new ChecklistReviewContext('', p);
        }
    }

    // Copy-paste schema both commands print. `required` is the set of checklists the diff MATCHED; empty
    // ⇒ output identical to a repo with no checklists. Non-empty ⇒ appends per-checklist instructions
    // naming the reviewer subagent + doc + the review-<id>.json to write.
    reviewJsonSchemaHint(filePath: string): string {
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
            `}`
        );
    }

    // The per-checklist review file path that sits beside review.json: review-<id>.json.
    checklistResultPath(reviewJsonFilePath: string, checklistId: string): string {
        return path.join(path.dirname(reviewJsonFilePath), `review-${checklistId}.json`);
    }

    /**
     * Load + validate the AI-authored review.json. Throws InformAiError (with the schema) when missing,
     * unparseable, or structurally wrong. `required` is the set of checklists the diff matched: every one
     * must have a well-formed, passing (or overridden) review-<id>.json or a validation error is raised
     * alongside the usual ones so the AI gets ONE message.
     */
    // webpieces-disable max-lines-new-methods -- one cohesive load+validate pass over the review fields
    loadReviewJson(filePath: string, required: readonly RequiredChecklist[] = []): ReviewJson {
        if (!fs.existsSync(filePath)) {
            throw new InformAiError(
                `Required review.json not found.\n\n${this.reviewJsonSchemaHint(filePath)}\n\n` +
                `Then re-run: pnpm wp-finish-upsert-pr`,
            );
        }

        const raw = this.parseReviewJson(fs.readFileSync(filePath, 'utf8'), filePath);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new InformAiError(`review.json must be a JSON object.\n\n${this.reviewJsonSchemaHint(filePath)}`);
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

        const results = this.loadChecklistResults(filePath, required);
        for (const err of this.requiredChecklistErrors(required, results)) errors.push(err);

        if (errors.length > 0) {
            throw new InformAiError(
                `review.json has ${errors.length} error(s) — fix ALL, then re-run pnpm wp-finish-upsert-pr:\n\n` +
                errors.map((e: string): string => `  • ${e}`).join('\n') +
                `\n\n${this.reviewJsonSchemaHint(filePath)}`,
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
            results,
        );
    }

    /**
     * The checklists that still OWE a verdict: no review-<id>.json at all, a malformed one, or one whose
     * verdict is an un-overridden FAIL. This is the set every message lists — a checklist already PASSed or
     * OVERRIDDEN on this branch is deliberately NOT re-listed, because re-instructing it invites a redundant
     * second run and reads as though the earlier verdict did not count.
     */
    pendingChecklists(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): RequiredChecklist[] {
        return required.filter((req: RequiredChecklist): boolean => {
            const status = this.resolveVerdict(req, results).status;
            return status !== CK_PASS && status !== CK_OVERRIDDEN;
        });
    }

    // Read the per-checklist verdict files `review-<id>.json` beside review.json — one per matched checklist.
    // A missing file is simply absent from the result (→ counts as MISSING for that checklist); a malformed
    // one is skipped (a stale review-<id>.json never wedges the branch).
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

    // Resolve ONE checklist's verdict from its review-<id>.json. Central so review.json enforcement AND the
    // finish-command dashboard agree on the outcome.
    resolveVerdict(req: RequiredChecklist, results: readonly ChecklistResult[]): ChecklistVerdict {
        const result = results.find((r: ChecklistResult): boolean => r.id === req.id);
        if (!result) return new ChecklistVerdict(req.id, CK_MISSING, '');
        if (result.success) return new ChecklistVerdict(req.id, CK_PASS, result.output);
        if (result.override.trim() !== '') return new ChecklistVerdict(req.id, CK_OVERRIDDEN, result.override.trim());
        return new ChecklistVerdict(req.id, CK_FAIL, result.output);
    }

    // Every matched checklist whose verdict is FAIL (reviewed, found a problem, no override) or MISSING (no
    // review-<id>.json written) → one error each, printing the reviewer's `output` verbatim.
    private requiredChecklistErrors(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): string[] {
        const errors: string[] = [];
        for (const req of required) {
            const verdict = this.resolveVerdict(req, results);
            if (verdict.status === CK_FAIL) {
                errors.push(
                    `Checklist "${req.id}" FAILED review. The reviewer (${req.subagent}) wrote:\n      ` +
                    `${verdict.detail.split('\n').join('\n      ')}\n` +
                    `      Fix it, then re-run; or set a non-empty "override" in ${this.checklistFileName(req.id)} to ship anyway with a stated justification.`,
                );
            } else if (verdict.status === CK_MISSING) {
                const doc = req.doc.trim() !== '' ? ` Read: ${req.doc}.` : '';
                errors.push(
                    `Checklist "${req.id}" MATCHED this diff but has no verdict. Spawn the "${req.subagent}" subagent to review it, ` +
                    `then write ${this.checklistFileName(req.id)} with {"id":"${req.id}","success":true,"output":"…"}.${doc}`,
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
export function reviewJsonSchemaHint(filePath: string): string {
    return reviewJsonSvc.reviewJsonSchemaHint(filePath);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function loadReviewJson(filePath: string, required: readonly RequiredChecklist[] = []): ReviewJson {
    return reviewJsonSvc.loadReviewJson(filePath, required);
}
