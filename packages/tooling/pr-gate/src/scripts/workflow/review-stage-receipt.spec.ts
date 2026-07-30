import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewJsonService } from '@webpieces/rules-config';
import { ReviewStageReceipt, ReviewStageReceiptService } from './review-stage-receipt';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-receipt-'));
    dirs.push(dir);
    return dir;
}

function svc(): ReviewStageReceiptService {
    return new ReviewStageReceiptService(new ReviewJsonService());
}

describe('ReviewStageReceiptService', () => {
    it('round-trips a receipt', () => {
        const repo = tmpRepo();
        const written = new ReviewStageReceipt('abc123', true, 'pnpm nx affected', '2026-07-30T00:00:00.000Z', ['db-reviewer']);
        svc().write(repo, 'feat', written);

        const read = svc().read(repo, 'feat');
        expect(read?.headSha).toBe('abc123');
        expect(read?.mergeValidated).toBe(true);
        expect(read?.buildPassedAt).toBe('2026-07-30T00:00:00.000Z');
        expect(read?.reviewersBriefed).toEqual(['db-reviewer']);
    });

    /**
     * ABSENT is the case that matters most. A repo with NO checklists has nothing else forcing stage ②:
     * `assertEveryReviewerRan` is vacuous there, and review.json — the only other interlock — is a file the
     * AI writes itself, so it could write it and go straight to finish, skipping the merge validation and
     * the build entirely. `null` is what makes wp-finish-upsert-pr refuse.
     */
    it('returns null when stage ② never ran', () => {
        expect(svc().read(tmpRepo(), 'feat')).toBeNull();
    });

    // Unreadable is treated as absent, which re-runs stage ② — the safe direction. Trusting a half-written
    // receipt would skip the build on a sha nothing verified.
    it('treats an unreadable receipt as absent rather than trusting it', () => {
        const repo = tmpRepo();
        const p = svc().receiptPath(repo, 'feat');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{ truncated mid-writ');
        expect(svc().read(repo, 'feat')).toBeNull();
    });

    // The sha is what finish compares to decide whether its build gate can be skipped, so it must survive
    // exactly. A receipt that lost its sha would silently force a rebuild on every finish.
    it('keeps the verified sha exactly, since finish skips its build on a match', () => {
        const repo = tmpRepo();
        svc().write(repo, 'feat', new ReviewStageReceipt('0123456789abcdef0123456789abcdef01234567', true, 'cmd', 'now', []));
        expect(svc().read(repo, 'feat')?.headSha).toBe('0123456789abcdef0123456789abcdef01234567');
    });

    it('lives beside review.json, in the per-feature pr-review dir', () => {
        const repo = tmpRepo();
        expect(svc().receiptPath(repo, 'feat'))
            .toBe(path.join(repo, '.webpieces', 'pr-review', 'feat', 'review-stage.json'));
    });
});
