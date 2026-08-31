import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistResult, RequiredChecklist, ReviewJsonService, loadReviewJson } from './review-json';
import { AuthorizedOverrides } from './human-authorization';
import { toError } from './to-error';

// No human has authorized anything in these tests unless one says so explicitly.
const NONE = new AuthorizedOverrides();

function tmpReviewWith(verdicts: Record<string, Record<string, string>>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-refusal-'));
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(file, JSON.stringify({
        title: 'Do the thing', riskScore: 10, riskLevel: 'green', summary: 's',
        violations: [], risks: [], filesToReview: [],
    }));
    for (const id of Object.keys(verdicts)) {
        fs.writeFileSync(path.join(dir, `review-${id}.json`), JSON.stringify({ id, override: '', ...verdicts[id] }));
    }
    return file;
}

const REQ = (id: string): RequiredChecklist => new RequiredChecklist(id, `${id}-reviewer`, '', ['x.sql'], ['**/*.sql']);

describe('refusedChecklists / refusalError', () => {
    const svc = new ReviewJsonService();
    const req = (id: string): RequiredChecklist => new RequiredChecklist(id, `${id}-reviewer`, '', ['x.sql'], ['**/*.sql']);

    // 'over' carries an override with no authorization behind it, so it is refused alongside the plain
    // failure: a reviewer ran and said no in both cases, and neither is a reviewer that merely never ran.
    it('selects the refusals — not MISSING, BAD_FORMAT, WARN or PASS — including an unauthorized override', () => {
        const required = [req('failed'), req('missing'), req('bad'), req('warn'), req('pass'), req('over')];
        const results = [
            new ChecklistResult('failed', 'red', 'refused', ''),
            new ChecklistResult('bad', '', 'ok', '', 'uses the removed "success" field'),
            new ChecklistResult('warn', 'yellow', 'a concern', ''),
            new ChecklistResult('pass', 'green', 'ok', ''),
            new ChecklistResult('over', 'red', 'refused', 'accepted, tracked in JIRA-1'),
        ];
        expect(svc.refusedChecklists(required, results, NONE).map((r): string => r.id)).toEqual(['failed', 'over']);
        const granted = new AuthorizedOverrides(new Map([['over', 'Accepted; JIRA-1.']]));
        expect(svc.refusedChecklists(required, results, granted).map((r): string => r.id)).toEqual(['failed']);
    });

    it('quotes the reviewer\'s own output — the finding is the whole point', () => {
        const results = [new ChecklistResult('a', 'red', 'gate 1: title names no ticket', '')];
        const text = svc.refusalError(req('a'), svc.resolveVerdict(req('a'), results, NONE));
        expect(text).toContain('gate 1: title names no ticket');
        expect(text).toContain('a-reviewer');
        expect(text).toContain('FAILED review');
    });

    /**
     * With an archive path the escape hatch must change. "Set override in review-<id>.json" is unfollowable
     * after the move — that file does not exist — so the text has to ask for a FRESH verdict file instead.
     */
    it('names the archive and asks for a FRESH verdict file when the verdict was retired', () => {
        const results = [new ChecklistResult('a', 'red', 'refused', '')];
        const archived = '/repo/.webpieces/pr-review/feat/review-a.json.old';
        const text = svc.refusalError(req('a'), svc.resolveVerdict(req('a'), results, NONE), archived);
        expect(text).toContain(archived);
        expect(text).toContain('RETIRED');
        expect(text).toContain('FRESH review-a.json');
        expect(text).toContain('HUMAN');
        expect(text).not.toContain(`set a non-empty "override" in review-a.json`);
    });

    // No regression in the review.json validation path: it now renders through refusalError, and must still
    // produce the same FAIL wording it always did, un-archived form.
    it('requiredChecklistErrors still produces the same FAIL wording via the extracted renderer', () => {
        const file = tmpReviewWith({ migrations: { status: 'red', output: 'NOT NULL without backfill' } });
        // webpieces-disable no-unmanaged-exceptions -- the assertion IS the thrown message
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            loadReviewJson(file, [REQ('migrations')], NONE);
            expect.fail('expected loadReviewJson to refuse');
        } catch (err: unknown) {
            const error = toError(err);
            expect(error.message).toContain('FAILED review (status:"red")');
            expect(error.message).toContain('NOT NULL without backfill');
            // The escape hatch is the HUMAN-ONLY mint now, not a field the agent reading this can write.
            expect(error.message).not.toContain('set a non-empty "override"');
            expect(error.message).toContain('pnpm wp-authorize --checklist migrations');
            expect(error.message).not.toContain('RETIRED');
        }
    });
});

/**
 * review.json validation and OPTIONAL checklists.
 *
 * `loadReviewJson` is the second gate (ReviewerVerdictGate is the first), and it enforced "every matched
 * checklist has a verdict" independently. It has to learn the same exemption, or a declined optional review
 * would sail past the gate and then be rejected here — with the OLD message, telling the AI to spawn a
 * reviewer the human just declined.
 */