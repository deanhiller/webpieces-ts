import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadReviewJson, prDirFor, reviewJsonPath, reviewJsonSchemaHint, RequiredChecklist } from './review-json';
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

const BLOCK = (id: string): RequiredChecklist =>
    new RequiredChecklist(id, `${id} title`, 'BLOCK', [`.claude/${id}.md`], `Walk ${id}.`, ['x.sql']);
const WARN = (id: string): RequiredChecklist =>
    new RequiredChecklist(id, `${id} title`, 'WARN', [`.claude/${id}.md`], '', ['x.sql']);

describe('loadReviewJson checklists', () => {
    it('throws when a BLOCK checklist has no verdict, quoting the consumer blockMessage', () => {
        const file = tmpFile(validReview());
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/Walk migrations\./);
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/has no verdict/);
    });

    it('passes when the BLOCK checklist is acknowledged: true', () => {
        const file = tmpFile(validReview({ checklists: [{ id: 'migrations', acknowledged: true, notes: ['walked it'] }] }));
        const review = loadReviewJson(file, [BLOCK('migrations')]);
        expect(review.checklists[0].id).toBe('migrations');
        expect(review.checklists[0].acknowledged).toBe(true);
        expect(review.checklists[0].notes).toEqual(['walked it']);
    });

    it('throws when the ack exists but acknowledged is false', () => {
        const file = tmpFile(validReview({ checklists: [{ id: 'migrations', acknowledged: false, notes: [] }] }));
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/has no verdict/);
    });

    it('never validates WARN checklists — an absent ack still passes', () => {
        const file = tmpFile(validReview());
        const review = loadReviewJson(file, [WARN('hasura')]);
        expect(review.title).toBe('Fix the thing');
        expect(review.checklists).toEqual([]);
    });

    it('ignores unknown ids in checklists[] (forward-compat)', () => {
        const file = tmpFile(validReview({ checklists: [
            { id: 'migrations', acknowledged: true, notes: [] },
            { id: 'some-future-id', acknowledged: true, notes: [] },
        ] }));
        const review = loadReviewJson(file, [BLOCK('migrations')]);
        expect(review.checklists.map((a): string => a.id)).toEqual(['migrations', 'some-future-id']);
    });

    it('required:[] produces a schema hint byte-identical to the no-argument call', () => {
        const p = '/repo/.webpieces/pr-review/feat/review.json';
        expect(reviewJsonSchemaHint(p, [])).toBe(reviewJsonSchemaHint(p));
        expect(reviewJsonSchemaHint(p)).not.toContain('checklists');
    });

    it('a non-empty required set injects the per-file instructions + docs into the schema hint', () => {
        const hint = reviewJsonSchemaHint('/repo/review.json', [BLOCK('migrations')]);
        expect(hint).toContain('review-migrations.json');
        expect(hint).toContain('.claude/migrations.md');
        expect(hint).toContain('BLOCK');
    });
});

describe('loadReviewJson per-checklist verdicts (review-<id>.json)', () => {
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

    it('passes a BLOCK when review-<id>.json has success:true', () => {
        const file = tmpReviewWith({ migrations: { success: true, output: 'no NOT NULL added' } });
        const review = loadReviewJson(file, [BLOCK('migrations')]);
        expect(review.results[0].id).toBe('migrations');
        expect(review.results[0].success).toBe(true);
    });

    it('refuses a BLOCK when success:false with no override, printing the reviewer output', () => {
        const file = tmpReviewWith({ migrations: { success: false, output: 'NOT NULL without backfill' } });
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/FAILED review/);
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/NOT NULL without backfill/);
    });

    it('passes a BLOCK when success:false but a non-empty override justification is given', () => {
        const file = tmpReviewWith({ migrations: { success: false, output: 'locks writes', override: 'behind a flag; ONE-2210' } });
        const review = loadReviewJson(file, [BLOCK('migrations')]);
        expect(review.results[0].override).toBe('behind a flag; ONE-2210');
    });

    it('prefers review-<id>.json over an inline ack when both exist', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-review-pref-'));
        const file = path.join(dir, 'review.json');
        fs.writeFileSync(file, validReview({ checklists: [{ id: 'migrations', acknowledged: true, notes: [] }] }));
        fs.writeFileSync(path.join(dir, 'review-migrations.json'), JSON.stringify({ success: false, output: 'bad' }));
        // The per-file FAIL wins over the inline ack:true → refuse.
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/FAILED review/);
    });

    it('two concurrent per-file writes both survive (no shared-file clobber)', () => {
        const file = tmpReviewWith({
            migrations: { success: true, output: 'ok' },
            dockerfiles: { success: true, output: 'ok' },
        });
        const review = loadReviewJson(file, [BLOCK('migrations'), BLOCK('dockerfiles')]);
        expect(review.results.map((r): string => r.id).sort()).toEqual(['dockerfiles', 'migrations']);
    });

    it('a WARN with a failing per-file verdict never blocks', () => {
        const file = tmpReviewWith({ hasura: { success: false, output: 'meh' } });
        const review = loadReviewJson(file, [WARN('hasura')]);
        expect(review.title).toBe('Fix the thing');
    });
});
