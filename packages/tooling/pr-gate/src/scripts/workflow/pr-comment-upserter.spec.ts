import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrCommentRequest, PrCommentUpserter } from './pr-comment-upserter';

// A PrCommentUpserter with both gh seams stubbed, so the upsert runs with no gh, no network and no PR.
class FakeUpserter extends PrCommentUpserter {
    calls: string[][] = [];
    existingId = '';
    status = 0;

    protected override findCommentId(prNumber: string, marker: string): string {
        this.calls.push(['find', prNumber, marker]);
        return this.existingId;
    }

    protected override gh(args: string[]): number {
        this.calls.push(args);
        return this.status;
    }
}

let dir = '';

function request(): PrCommentRequest {
    const r = new PrCommentRequest();
    r.prNumber = '42';
    r.marker = '<!-- webpieces-pr-detail v1 -->';
    r.body = '<!-- webpieces-pr-detail v1 -->\n## Dashboard';
    r.payloadDir = dir;
    r.payloadName = 'detail-comment.json';
    r.label = 'full dashboard comment';
    return r;
}

beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-comment-upsert-'));
});

afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('PrCommentUpserter — idempotency is the whole contract', () => {
    /**
     * `wp-finish-upsert-pr` re-runs on EVERY push. A PR that grew a new dashboard comment per push would
     * be unreadable, and worse, `wp-check-pr` would have several bodies to pick a gate token from.
     */
    it('PATCHes the existing comment when one carries the marker', () => {
        const up = new FakeUpserter();
        up.existingId = '999';
        const result = up.upsert(request());

        expect(result.ok).toBe(true);
        expect(result.updated).toBe(true);
        const gh = up.calls.find((c: string[]): boolean => c[0] === 'api') ?? [];
        expect(gh).toContain('PATCH');
        expect(gh.join(' ')).toContain('issues/comments/999');
    });

    it('POSTs a new comment when none exists yet', () => {
        const up = new FakeUpserter();
        const result = up.upsert(request());

        expect(result.updated).toBe(false);
        const gh = up.calls.find((c: string[]): boolean => c[0] === 'api') ?? [];
        expect(gh).toContain('POST');
        expect(gh.join(' ')).toContain('issues/42/comments');
    });

    /** The body travels as a JSON payload file, because `gh api --input` cannot take it on argv. */
    it('writes the body as a JSON payload gh api can consume', () => {
        const up = new FakeUpserter();
        up.upsert(request());
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'detail-comment.json'), 'utf8'));
        expect(written.body).toContain('## Dashboard');
    });

    /**
     * The payload name is per-request precisely so the two comments finish posts in ONE run cannot
     * clobber each other's file. They used to be one hard-coded `checklist-comment.json`.
     */
    it('keeps the two comments in separate payload files within one run', () => {
        const up = new FakeUpserter();
        up.upsert(request());
        const checklist = request();
        checklist.payloadName = 'checklist-comment.json';
        checklist.body = 'reviewer output';
        up.upsert(checklist);

        expect(JSON.parse(fs.readFileSync(path.join(dir, 'detail-comment.json'), 'utf8')).body)
            .toContain('## Dashboard');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'checklist-comment.json'), 'utf8')).body)
            .toBe('reviewer output');
    });
});

describe('PrCommentUpserter — failure is reported, never thrown', () => {
    /**
     * Every caller reaches this AFTER the PR is up. Throwing here would turn a finished run into a failed
     * one over a comment, so the verdict is returned and the CALLER decides whether it matters.
     */
    it('returns ok:false rather than throwing when gh fails', () => {
        const up = new FakeUpserter();
        up.status = 1;
        expect((): void => {
            const r = up.upsert(request());
            expect(r.ok).toBe(false);
        }).not.toThrow();
    });

    /** No PR number ⇒ nothing to comment on. A silent no-op, not an error and not a gh call. */
    it('no-ops without calling gh when there is no PR', () => {
        const up = new FakeUpserter();
        const r = request();
        r.prNumber = '';
        const result = up.upsert(r);

        expect(result.ok).toBe(false);
        expect(up.calls).toEqual([]);
    });
});
