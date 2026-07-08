import * as fs from 'fs';
import * as path from 'path';
import { WEBPIECES_TMP_DIR, PR_INFO_DIR } from './constants';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

// The AI-authored review for a PR. webpieces is AI-first, so unlike trytami (where a human command
// calls Claude), the AI writes this file itself between `wp-start-upsert-pr` (which prints the
// schema + instructions) and `wp-finish-upsert-pr` (which reads it to render the RISK section and
// post the PR). Data-only (per CLAUDE.md, classes for data).
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

// The per-feature PR working dir: `.webpieces/pr-info/<feature>`. Holds pr-body.md (rendered
// dashboard) and review.json (AI-authored review). Nested under pr-info/ to keep `.webpieces/`
// top level quiet. Shared so the start/finish commands and the AI agree on one location.
export function prDirFor(repoRoot: string, featureName: string): string {
    return path.join(repoRoot, WEBPIECES_TMP_DIR, PR_INFO_DIR, featureName);
}

// Absolute path of the review.json for a feature — beside pr-body.md, keyed by branch name so the
// AI and the finish command agree on the location without passing it around.
export function reviewJsonPath(repoRoot: string, featureName: string): string {
    return path.join(prDirFor(repoRoot, featureName), 'review.json');
}

// Copy-paste schema both commands print: wp-start-upsert-pr to instruct the AI to WRITE it,
// wp-finish-upsert-pr to instruct the AI to FIX it when missing/invalid.
export function reviewJsonSchemaHint(filePath: string): string {
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

// webpieces-disable no-any-unknown -- opaque parsed JSON value, narrowed to string[] here
function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    // webpieces-disable no-any-unknown -- element of an opaque JSON array, narrowed by the type guard
    return value.filter((v: unknown): v is string => typeof v === 'string');
}

// Parse opaque AI-authored JSON, converting a SyntaxError into a readable InformAiError the AI can
// act on (mirrors readRawConfig in config-file.ts — the established JSON-parse chokepoint).
// webpieces-disable no-any-unknown -- returns the opaque parsed object; the caller narrows each field
function parseReviewJson(raw: string, filePath: string): Record<string, unknown> {
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: convert JSON.parse SyntaxError to an InformAiError for the AI
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed by the caller
        return JSON.parse(raw) as Record<string, unknown>;
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(
            `review.json is not valid JSON (${error.message}).\n\n${reviewJsonSchemaHint(filePath)}\n\n` +
            `Then re-run: pnpm wp-finish-upsert-pr`,
        );
    }
}

/**
 * Load + validate the AI-authored review.json. Throws InformAiError (with the schema) when the file
 * is missing, unparseable, or structurally wrong — the message is written straight back to the AI so
 * it can fix the file and re-run. Returns a fully-populated ReviewJson on success.
 */
export function loadReviewJson(filePath: string): ReviewJson {
    if (!fs.existsSync(filePath)) {
        throw new InformAiError(
            `Required review.json not found.\n\n${reviewJsonSchemaHint(filePath)}\n\n` +
            `Then re-run: pnpm wp-finish-upsert-pr`,
        );
    }

    const raw = parseReviewJson(fs.readFileSync(filePath, 'utf8'), filePath);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new InformAiError(`review.json must be a JSON object.\n\n${reviewJsonSchemaHint(filePath)}`);
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

    // Title is REQUIRED (hard-reject): the AI must author a real PR title. We no longer silently fall
    // back to the feature name — an empty title means the AI skipped the field, which is a review gap.
    const title = typeof raw['title'] === 'string' ? (raw['title'] as string).trim() : '';
    if (title === '') {
        errors.push('"title" must be a non-empty, imperative PR title describing the change (no branch names).');
    }

    if (errors.length > 0) {
        throw new InformAiError(
            `review.json has ${errors.length} error(s) — fix ALL, then re-run pnpm wp-finish-upsert-pr:\n\n` +
            errors.map((e: string): string => `  • ${e}`).join('\n') +
            `\n\n${reviewJsonSchemaHint(filePath)}`,
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
        asStringArray(raw['violations']),
        asStringArray(raw['risks']),
        asStringArray(raw['filesToReview']),
    );
}
