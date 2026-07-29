import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadReviewJson, prDirFor, reviewJsonPath, reviewJsonSchemaHint, RequiredChecklist, ReviewJsonService, PrContext } from './review-json';
import { WEBPIECES_TMP_DIR, PR_REVIEW_DIR } from './constants';
import { InformAiError } from './inform-ai-error';

function tmpFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-review-'));
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(file, contents);
    return file;
}

describe('reviewJsonPath', () => {
    it('places review.json under the per-feature pr-review dir', () => {
        const p = reviewJsonPath('/repo', 'dean-feat');
        expect(p).toBe(path.join('/repo', WEBPIECES_TMP_DIR, PR_REVIEW_DIR, 'dean-feat', 'review.json'));
    });

    it('prDirFor returns the pr-review home for a feature', () => {
        const p = prDirFor('/repo', 'dean-feat');
        expect(p).toBe(path.join('/repo', WEBPIECES_TMP_DIR, PR_REVIEW_DIR, 'dean-feat'));
    });
});

describe('loadReviewJson', () => {
    it('loads a valid review and derives the emoji from riskLevel', () => {
        const file = tmpFile(JSON.stringify({
            title: 'Fix the thing', riskScore: 42, riskLevel: 'yellow', summary: 'ok',
            violations: ['a'], risks: [], filesToReview: ['x.ts'],
        }));
        const review = loadReviewJson(file);
        expect(review.riskScore).toBe(42);
        expect(review.riskLevel).toBe('yellow');
        expect(review.riskEmoji).toBe('🟡');
        expect(review.violations).toEqual(['a']);
        expect(review.filesToReview).toEqual(['x.ts']);
    });

    it('reads a trimmed title and REQUIRES it (hard-reject when absent or blank)', () => {
        const withTitle = tmpFile(JSON.stringify({ title: '  Fix the thing  ', riskScore: 10, riskLevel: 'green' }));
        expect(loadReviewJson(withTitle).title).toBe('Fix the thing');
        const without = tmpFile(JSON.stringify({ riskScore: 10, riskLevel: 'green' }));
        expect(() => loadReviewJson(without)).toThrowError(/"title" must be a non-empty/);
        const blank = tmpFile(JSON.stringify({ title: '   ', riskScore: 10, riskLevel: 'green' }));
        expect(() => loadReviewJson(blank)).toThrowError(/"title" must be a non-empty/);
    });

    it('throws InformAiError with the schema when the file is missing', () => {
        expect(() => loadReviewJson('/nope/review.json')).toThrowError(InformAiError);
        expect(() => loadReviewJson('/nope/review.json')).toThrowError(/Required review.json not found/);
    });

    it('throws on malformed JSON', () => {
        const file = tmpFile('{ not json');
        expect(() => loadReviewJson(file)).toThrowError(/not valid JSON/);
    });

    it('throws on an out-of-range riskScore and a bad riskLevel', () => {
        const file = tmpFile(JSON.stringify({ riskScore: 200, riskLevel: 'orange' }));
        expect(() => loadReviewJson(file)).toThrowError(/riskScore.*0–100/);
    });
});

function validReview(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        title: 'Fix the thing', riskScore: 10, riskLevel: 'green', summary: 'ok',
        violations: [], risks: [], filesToReview: [], ...overrides,
    });
}

const REQ = (id: string): RequiredChecklist =>
    new RequiredChecklist(id, id, `.claude/review/${id}.md`, ['x.sql']);

// Write review.json + optional per-checklist files into one shared dir; return the review.json path.
function tmpReviewWith(results: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-review-pf-'));
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(file, validReview());
    for (const [id, body] of Object.entries(results)) {
        fs.writeFileSync(path.join(dir, `review-${id}.json`), JSON.stringify(body));
    }
    return file;
}

describe('writePrContext', () => {
    it('writes base/head/changedFiles JSON to pr-context.json and round-trips', () => {
        const svc = new ReviewJsonService();
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prctx-'));
        const p = svc.writePrContext(repo, 'feat', new PrContext('base123', 'head456', ['a.ts', 'db/1.sql']));
        expect(p).toBe(svc.prContextPath(repo, 'feat'));
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(parsed).toEqual({ base: 'base123', head: 'head456', changedFiles: ['a.ts', 'db/1.sql'] });
    });
});

describe('loadReviewJson checklists (review-<id>.json verdicts)', () => {
    it('throws when a matched checklist has no verdict, naming the reviewer subagent', () => {
        const file = tmpFile(validReview());
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/has no verdict/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/"migrations" subagent/);
    });

    it('passes when review-<id>.json has success:true', () => {
        const file = tmpReviewWith({ migrations: { id: 'migrations', success: true, output: 'no NOT NULL added' } });
        const review = loadReviewJson(file, [REQ('migrations')]);
        expect(review.results[0].id).toBe('migrations');
        expect(review.results[0].success).toBe(true);
    });

    it('refuses success:false with no override, printing the reviewer output', () => {
        const file = tmpReviewWith({ migrations: { success: false, output: 'NOT NULL without backfill' } });
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/FAILED review/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/NOT NULL without backfill/);
    });

    it('passes success:false when a non-empty override justification is given', () => {
        const file = tmpReviewWith({ migrations: { success: false, output: 'locks writes', override: 'behind a flag; ONE-2210' } });
        const review = loadReviewJson(file, [REQ('migrations')]);
        expect(review.results[0].override).toBe('behind a flag; ONE-2210');
    });

    it('two concurrent per-file writes both survive (no shared-file clobber)', () => {
        const file = tmpReviewWith({
            migrations: { success: true, output: 'ok' },
            dockerfiles: { success: true, output: 'ok' },
        });
        const review = loadReviewJson(file, [REQ('migrations'), REQ('dockerfiles')]);
        expect(review.results.map((r): string => r.id).sort()).toEqual(['dockerfiles', 'migrations']);
    });

    it('required:[] produces a schema hint byte-identical to the no-argument call', () => {
        const p = '/repo/.webpieces/pr-review/feat/review.json';
        expect(reviewJsonSchemaHint(p, [])).toBe(reviewJsonSchemaHint(p));
        expect(reviewJsonSchemaHint(p)).not.toContain('checklist');
    });

    it('a non-empty required set injects the per-file instructions + subagent + doc into the schema hint', () => {
        const hint = reviewJsonSchemaHint('/repo/review.json', [REQ('migrations')]);
        expect(hint).toContain('review-migrations.json');
        expect(hint).toContain('.claude/review/migrations.md');
        expect(hint).toContain('subagent: migrations');
    });
});
