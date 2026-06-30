import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadReviewJson, prDirFor, reviewJsonPath } from './review-json';
import { WEBPIECES_TMP_DIR, PR_INFO_DIR } from './constants';
import { InformAiError } from './inform-ai-error';

function tmpFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-review-'));
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(file, contents);
    return file;
}

describe('reviewJsonPath', () => {
    it('places review.json under the per-feature pr-info dir', () => {
        const p = reviewJsonPath('/repo', 'dean-feat');
        expect(p).toBe(path.join('/repo', WEBPIECES_TMP_DIR, PR_INFO_DIR, 'dean-feat', 'review.json'));
    });

    it('prDirFor returns the pr-info home for a feature', () => {
        const p = prDirFor('/repo', 'dean-feat');
        expect(p).toBe(path.join('/repo', WEBPIECES_TMP_DIR, PR_INFO_DIR, 'dean-feat'));
    });
});

describe('loadReviewJson', () => {
    it('loads a valid review and derives the emoji from riskLevel', () => {
        const file = tmpFile(JSON.stringify({
            riskScore: 42, riskLevel: 'yellow', summary: 'ok',
            violations: ['a'], risks: [], filesToReview: ['x.ts'],
        }));
        const review = loadReviewJson(file);
        expect(review.riskScore).toBe(42);
        expect(review.riskLevel).toBe('yellow');
        expect(review.riskEmoji).toBe('🟡');
        expect(review.violations).toEqual(['a']);
        expect(review.filesToReview).toEqual(['x.ts']);
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
