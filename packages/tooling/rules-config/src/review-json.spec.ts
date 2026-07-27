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
    it('throws when a BLOCK checklist is not acknowledged, quoting the consumer blockMessage', () => {
        const file = tmpFile(validReview());
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/Walk migrations\./);
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/not acknowledged/);
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
        expect(() => loadReviewJson(file, [BLOCK('migrations')])).toThrowError(/not acknowledged/);
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

    it('a non-empty required set injects the checklist section + docs into the schema hint', () => {
        const hint = reviewJsonSchemaHint('/repo/review.json', [BLOCK('migrations')]);
        expect(hint).toContain('"checklists"');
        expect(hint).toContain('.claude/migrations.md');
        expect(hint).toContain('BLOCK');
    });
});
