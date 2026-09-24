import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewJsonService } from './review-json';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';
import { specTempDirs } from './spec-temp-dirs';

/**
 * #1033: the author's file was renamed review.json → summary.json because Claude auto-mode refused an
 * agent writing "review.json" beside the reviewers' review-<id>.json verdicts as Self-Approval. HARD CUT:
 * a stale review.json is never read, even when it is perfectly valid — the refusal only names the
 * destination, and the "write the PR summary" wording never calls it a review.
 */
describe('the author file is summary.json, with no fallback to review.json', () => {
    it('NEVER reads a stale review.json — refuses and names summary.json as the destination', () => {
        const dir = specTempDirs.make('wp-summary-');
        const stale = path.join(dir, 'review.json');
        fs.writeFileSync(stale, JSON.stringify({ title: 'Old name', agent: 'claude', model: 'opus', riskScore: 1, riskLevel: 'green' }));
        const file = path.join(dir, 'summary.json');
        expect((): unknown => new ReviewJsonService().loadSummaryJson(file)).toThrowError(InformAiError);
        // webpieces-disable no-unmanaged-exceptions -- the assertion IS the thrown message
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            new ReviewJsonService().loadSummaryJson(file);
            expect.fail('expected loadSummaryJson to refuse');
        } catch (err: unknown) {
            const error = toError(err);
            expect(error.message).toContain(`${stale} is IGNORED`);
            expect(error.message).toContain(`Write the same JSON to ${file}`);
            expect(error.message).toContain('Write the PR summary to:');
            expect(error.message).not.toContain('PR review');
        }
    });

    it('says nothing about the old name when no stale review.json exists', () => {
        expect(() => new ReviewJsonService().loadSummaryJson('/nope/summary.json')).not.toThrowError(/IGNORED/);
    });
});
