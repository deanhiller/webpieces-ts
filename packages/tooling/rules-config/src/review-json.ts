import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { WEBPIECES_TMP_DIR, PR_REVIEW_DIR } from './constants';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

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

    constructor(
        title: string,
        riskScore: number,
        riskLevel: string,
        riskEmoji: string,
        summary: string,
        violations: string[],
        risks: string[],
        filesToReview: string[],
    ) {
        this.title = title;
        this.riskScore = riskScore;
        this.riskLevel = riskLevel;
        this.riskEmoji = riskEmoji;
        this.summary = summary;
        this.violations = violations;
        this.risks = risks;
        this.filesToReview = filesToReview;
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

    // Copy-paste schema both commands print (write it / fix it).
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

    /**
     * Load + validate the AI-authored review.json. Throws InformAiError (with the schema) when missing,
     * unparseable, or structurally wrong. Returns a fully-populated ReviewJson on success.
     */
    // webpieces-disable max-lines-new-methods -- one cohesive load+validate pass over the review fields
    loadReviewJson(filePath: string): ReviewJson {
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
        );
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
export function loadReviewJson(filePath: string): ReviewJson {
    return reviewJsonSvc.loadReviewJson(filePath);
}
