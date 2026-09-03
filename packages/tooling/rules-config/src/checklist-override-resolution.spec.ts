import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistOverride, ChecklistResult, RequiredChecklist, ReviewJsonService } from './review-json';

/**
 * `override-<id>.json` END TO END, through the two surfaces that actually decide anything: what
 * `loadReviewJson` resolves a red verdict to, and what the refusal PRINTS when there is no authorization.
 *
 * Separate from review-json.spec.ts because that file is at the `max-file-lines` limit and because this is
 * its own subject — the split between "what the reviewer found" and "what the human decided", which is the
 * whole reason the override left the verdict file. `checklist-override.spec.ts` covers the reader and the
 * command renderer in isolation; this covers them wired into the gate.
 */

const REQ = (id: string): RequiredChecklist =>
    new RequiredChecklist(id, `${id}-reviewer`, `.claude/review/${id}.md`, ['x.sql']);

const VALID_REVIEW = JSON.stringify({
    title: 'Fix the thing', riskScore: 10, riskLevel: 'green', summary: 'ok',
    violations: [], risks: [], filesToReview: [],
});

// review.json + one verdict + (optionally) the human's authorization, in one dir. The authorization is a
// SEPARATE file because it is a different act by a different writer — see ChecklistOverride.
function tmpDirWith(id: string, verdict: unknown, override: unknown = null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-override-res-'));
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(file, VALID_REVIEW);
    fs.writeFileSync(path.join(dir, `review-${id}.json`), JSON.stringify(verdict));
    if (override !== null) fs.writeFileSync(path.join(dir, `override-${id}.json`), JSON.stringify(override));
    return file;
}

describe('loadReviewJson resolves a red verdict against override-<id>.json', () => {
    it('SHIPS a red verdict the human authorized, carrying the reason and its provenance', () => {
        const file = tmpDirWith(
            'migrations',
            { status: 'red', output: 'locks writes' },
            new ChecklistOverride('migrations', 'human, in-session', '2026-09-03T18:22:11Z', 'behind a flag; ONE-2210'),
        );
        const review = new ReviewJsonService().loadReviewJson(file, [REQ('migrations')]);
        const override = review.results[0].override;
        expect(override?.reason).toBe('behind a flag; ONE-2210');
        expect(override?.authorizedBy).toBe('human, in-session');
        expect(override?.authorizedAt).toBe('2026-09-03T18:22:11Z');
    });

    it('still REFUSES a red verdict with no authorization beside it', () => {
        const file = tmpDirWith('migrations', { status: 'red', output: 'NOT NULL without backfill' });
        expect(() => new ReviewJsonService().loadReviewJson(file, [REQ('migrations')]))
            .toThrowError(/NOT NULL without backfill/);
    });

    // An authorization with no stated reason is an assertion, not a record. It must not ship — and it must
    // not silently read as "nobody authorized anything" either, or the writer never learns it did not count.
    it('refuses an authorization with no reason, and says which file to rewrite', () => {
        const file = tmpDirWith(
            'migrations',
            { status: 'red', output: 'locks writes' },
            new ChecklistOverride('migrations', 'human, in-session', '2026-09-03T18:22:11Z', ''),
        );
        expect(() => new ReviewJsonService().loadReviewJson(file, [REQ('migrations')]))
            .toThrowError(/is missing "reason"/);
    });

    /**
     * The MOVED field, rejected with the destination named — the `success` precedent applied to `override`.
     * Rejected even when EMPTY, because the leftover `"override": ""` sitting in a reviewer's file is the
     * copy that teaches the next reviewer the field still exists.
     */
    it('rejects a verdict still carrying the MOVED "override" field, even when it is empty', () => {
        const file = tmpDirWith('migrations', { status: 'green', output: 'fine', override: '' });
        expect(() => new ReviewJsonService().loadReviewJson(file, [REQ('migrations')]))
            .toThrowError(/MOVED "override" field/);
        expect(() => new ReviewJsonService().loadReviewJson(file, [REQ('migrations')]))
            .toThrowError(/override-migrations\.json/);
    });
});

/**
 * The refusal's ship-anyway paragraph. This is the half that was missing: the old text said WHAT to write
 * and WHERE but never WHO MAY, so the only reachable move was an agent editing a reviewer's verdict in
 * place — which the harness denies, which is how a human ended up hand-editing JSON.
 */
describe('refusalError prints the override route', () => {
    const svc = new ReviewJsonService();
    const REVIEW_PATH = '/repo/.webpieces/pr-review/feat/review.json';
    const req = (id: string): RequiredChecklist => new RequiredChecklist(id, `${id}-reviewer`, '', ['x.sql'], ['**/*.sql']);
    const refusalFor = (id: string): string => {
        const results = [new ChecklistResult(id, 'red', 'refused', null)];
        return svc.refusalError(req(id), svc.resolveVerdict(req(id), results), REVIEW_PATH);
    };

    it('is a ready-to-run heredoc with the real id and the real path', () => {
        const text = refusalFor('a');
        expect(text).toContain("cat > /repo/.webpieces/pr-review/feat/override-a.json <<'JSON'");
        expect(text).toContain('"checklistId": "a"');
        expect(text).toContain('"authorizedBy": "human, in-session"');
        expect(text).toContain("REPLACE THIS with the human's own words, verbatim");
        // The closing delimiter must sit at column 0, or the pasted command hangs the shell.
        expect(text).toContain('\nJSON\n');
    });

    it('names the coordinating agent as the only legal writer, and rules out a relay as consent', () => {
        const text = refusalFor('a');
        expect(text).toContain('COORDINATING agent');
        expect(text).toContain('NOT self-authorization');
        expect(text).toContain('NOT consent');
    });

    // An override is per-checklist and it STANDS. A `findingDigest` was specified and then removed: `output`
    // is LLM prose, so a re-run rewords the same finding and the hash would lapse on essentially every
    // re-review — the re-authorization dance this whole split exists to delete.
    it('offers no digest, expiry or branch/sha scoping', () => {
        const text = refusalFor('a');
        expect(text).not.toContain('findingDigest');
        expect(text).not.toContain('expires');
    });
});
