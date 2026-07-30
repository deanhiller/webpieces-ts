import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadReviewJson, prDirFor, reviewJsonPath, reviewJsonSchemaHint, RequiredChecklist, ChecklistResult, ChecklistReviewContext, ReviewJsonService, PrContext } from './review-json';
import { ChecklistInstructionsService } from './checklist-instructions';
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

    it('passes when review-<id>.json has status:green', () => {
        const file = tmpReviewWith({ migrations: { id: 'migrations', status: 'green', output: 'no NOT NULL added' } });
        const review = loadReviewJson(file, [REQ('migrations')]);
        expect(review.results[0].id).toBe('migrations');
        expect(review.results[0].status).toBe('green');
    });

    it('refuses status:red with no override, printing the reviewer output', () => {
        const file = tmpReviewWith({ migrations: { status: 'red', output: 'NOT NULL without backfill' } });
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/FAILED review/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/NOT NULL without backfill/);
    });

    it('passes status:red when a non-empty override justification is given', () => {
        const file = tmpReviewWith({ migrations: { status: 'red', output: 'locks writes', override: 'behind a flag; ONE-2210' } });
        const review = loadReviewJson(file, [REQ('migrations')]);
        expect(review.results[0].override).toBe('behind a flag; ONE-2210');
    });

    // 'yellow' SHIPS. It exists so a reviewer can pass a change and still flag a concern, instead of failing
    // the PR and overriding its own failure — which reads as a deliberately-accepted defect, not a note.
    it('passes status:yellow — a concern is published, not a blocker', () => {
        const file = tmpReviewWith({ migrations: { status: 'yellow', output: 'index added without CONCURRENTLY' } });
        const review = loadReviewJson(file, [REQ('migrations')]);
        expect(review.results[0].status).toBe('yellow');
    });

    it('two concurrent per-file writes both survive (no shared-file clobber)', () => {
        const file = tmpReviewWith({
            migrations: { status: 'green', output: 'ok' },
            dockerfiles: { status: 'green', output: 'ok' },
        });
        const review = loadReviewJson(file, [REQ('migrations'), REQ('dockerfiles')]);
        expect(review.results.map((r): string => r.id).sort()).toEqual(['dockerfiles', 'migrations']);
    });

    // The schema hint is now ONLY the review.json shape. Checklist instructions moved to
    // ChecklistInstructionsService (one renderer, shared by wp-checklist / wp-finish / this file's errors) —
    // they used to be appended here AND printed by wp-start, two copies that could drift.
    it('carries no checklist instructions at all — that is ChecklistInstructionsService now', () => {
        const hint = reviewJsonSchemaHint('/repo/review.json');
        expect(hint).toContain('"riskScore"');
        expect(hint).not.toContain('subagent');
        expect(hint).not.toContain('review-');
    });
});

// `success` was removed outright. The point of these cases is the MESSAGE, not just the refusal: a verdict
// file that exists must never be reported as one that was never written, or the AI re-runs a reviewer that
// already ran instead of correcting four characters of JSON.
describe('loadReviewJson — the removed `success` field', () => {
    it('names `success` as removed and does NOT claim the verdict is missing', () => {
        const file = tmpReviewWith({ migrations: { id: 'migrations', success: true, output: 'ok' } });
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/"success"/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/REMOVED/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).not.toThrowError(/has no verdict/);
    });

    it('prints the replacement shape, so the fix needs no doc lookup', () => {
        const file = tmpReviewWith({ migrations: { success: false, output: 'bad' } });
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/green \| yellow \| red/);
    });

    it('reports an INVALID status as invalid — not as a legacy file and not as a missing one', () => {
        const file = tmpReviewWith({ migrations: { id: 'migrations', status: 'purple', output: 'ok' } });
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/no valid "status"/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).not.toThrowError(/has no verdict/);
        expect(() => loadReviewJson(file, [REQ('migrations')])).not.toThrowError(/"success"/);
    });

    // Unparseable bytes stay tolerant: a half-written file degrades to the same message as an absent one,
    // which is honest — there is nothing readable there — and never wedges the branch.
    it('still degrades unparseable JSON to the missing-verdict message', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-review-bad-'));
        const file = path.join(dir, 'review.json');
        fs.writeFileSync(file, validReview());
        fs.writeFileSync(path.join(dir, 'review-migrations.json'), '{ not json');
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/has no verdict/);
    });
});

// The set every message lists. An already-reviewed checklist must NOT reappear: re-instructing it invites a
// redundant second reviewer run and reads as though the earlier verdict did not count.
describe('ReviewJsonService.pendingChecklists', () => {
    const svc2 = new ReviewJsonService();
    const req = (id: string): RequiredChecklist => new RequiredChecklist(id, id, '', ['x.sql'], ['**/*.sql']);

    it('drops the ones that passed and keeps the ones with no verdict', () => {
        const required = [req('a'), req('b')];
        const results = [new ChecklistResult('a', 'green', 'ok', '')];
        expect(svc2.pendingChecklists(required, results).map((r): string => r.id)).toEqual(['b']);
    });

    it('keeps an un-overridden FAIL (it still owes a passing verdict)', () => {
        const results = [new ChecklistResult('a', 'red', 'bad', '')];
        expect(svc2.pendingChecklists([req('a')], results).map((r): string => r.id)).toEqual(['a']);
    });

    it('drops an OVERRIDDEN fail — the ship-anyway decision was stated, so it is resolved', () => {
        const results = [new ChecklistResult('a', 'red', 'bad', 'accepted, tracked in JIRA-1')];
        expect(svc2.pendingChecklists([req('a')], results)).toEqual([]);
    });

    // The mis-gate guard. A yellow verdict SHIPS, so it must not be listed as owed — if it were, the
    // outstanding set would never empty and wp-finish would refuse the PR forever no matter how many times
    // the reviewer ran.
    it('drops a YELLOW verdict — it passed, with a concern published rather than a blocker raised', () => {
        const results = [new ChecklistResult('a', 'yellow', 'no rate limit on the new route', '')];
        expect(svc2.pendingChecklists([req('a')], results)).toEqual([]);
    });

    it('keeps a verdict whose FORMAT could not be read (it never resolved to an outcome)', () => {
        const results = [new ChecklistResult('a', '', 'ok', '', 'uses the removed "success" field')];
        expect(svc2.pendingChecklists([req('a')], results).map((r): string => r.id)).toEqual(['a']);
    });
});

// The ONE renderer behind wp-checklist, wp-finish's fail-fast, and review.json validation errors.
describe('ChecklistInstructionsService', () => {
    const inst = new ChecklistInstructionsService(new ReviewJsonService());
    const CTX = new ChecklistReviewContext('abc1234', '/repo/.webpieces/pr-review/feat/pr-context.json');
    const REVIEW = '/repo/.webpieces/pr-review/feat/review.json';

    it('renders nothing at all when nothing is pending, so callers can concatenate blindly', () => {
        expect(inst.render([], REVIEW, CTX)).toBe('');
    });

    it('names each subagent, its repo-relative doc, and the exact verdict file it must write', () => {
        const req = new RequiredChecklist('db', 'db-reviewer', '.claude/review/db.md', ['db/1.sql'], ['**/*.sql']);
        const text = inst.render([req], REVIEW, CTX);
        expect(text).toContain('• db-reviewer');
        expect(text).toContain('doc to read:  .claude/review/db.md');
        expect(text).toContain('/repo/.webpieces/pr-review/feat/review-db.json');
    });

    it('states the ONE verdict format once, not repeated under every reviewer', () => {
        const two = [
            new RequiredChecklist('a', 'a', '', ['x'], ['**']),
            new RequiredChecklist('b', 'b', '', ['x'], ['**']),
        ];
        const text = inst.render(two, REVIEW, CTX);
        expect(text.split('"override": ""').length - 1).toBe(1);
    });

    // The block must never get quietly SHORTER. It used to omit the diff lines entirely when no base
    // resolved, leaving a reviewer with filenames and no way to read the change — indistinguishable from a
    // complete instruction. An unresolvable base is now stated as the problem it is.
    it('states an unresolvable base out loud instead of omitting the diff instruction', () => {
        const req = new RequiredChecklist('a', 'a', '', ['x.ts'], ['**']);
        const text = inst.render([req], REVIEW, new ChecklistReviewContext());
        expect(text).toContain('No diff base resolved');
        expect(text).toContain('merge-base origin/main HEAD');
    });

    it('inlines the diff command with the real base sha and the authoritative full-file-set path', () => {
        const req = new RequiredChecklist('a', 'a', '', ['x'], ['**']);
        const text = inst.render([req], REVIEW, CTX);
        expect(text).toContain('git diff abc1234 HEAD -- <file>');
        expect(text).toContain('/repo/.webpieces/pr-review/feat/pr-context.json');
    });

    // A truncated list that looks complete is how a reviewer reviews 6 of 40 files and reports success.
});

// Split out to keep each describe inside the method-length limit.
describe('ChecklistInstructionsService — scope wording and lossless lists', () => {
    const inst = new ChecklistInstructionsService(new ReviewJsonService());
    const CTX = new ChecklistReviewContext('abc1234', '/repo/.webpieces/pr-review/feat/pr-context.json');
    const REVIEW = '/repo/.webpieces/pr-review/feat/review.json';

    it('never truncates the matched list silently — it states how many were dropped', () => {
        const many = Array.from({ length: 40 }, (_v: unknown, i: number): string => `db/${i}.sql`);
        const req = new RequiredChecklist('a', 'a', '', many, ['**/*.sql']);
        expect(inst.render([req], REVIEW, CTX)).toContain('+34 more (40 total)');
    });

    it('names the glob that fired, so a precise match is distinguishable from a blanket one', () => {
        const req = new RequiredChecklist('a', 'a', '', ['db/1.sql'], ['**/*.sql']);
        expect(inst.render([req], REVIEW, CTX)).toContain('matched "**/*.sql"');
    });

    // NOT every checklist is pattern-matched. Calling a patternless checklist's file list "matched" implies
    // it is a narrow slice of the diff when it is in fact the whole thing.
    it('says ALWAYS RUNS for a patternless checklist instead of calling the whole diff a match', () => {
        const req = new RequiredChecklist('a', 'a', '', ['x.ts', 'y.ts'], []);
        const text = inst.render([req], REVIEW, CTX);
        expect(text).toContain('ALWAYS RUNS');
        expect(text).toContain('all 2 changed file(s)');
        expect(text).not.toContain('file(s) matched');
    });

    it('names() gives a one-line list for a fail-fast headline', () => {
        const two = [
            new RequiredChecklist('a', 'a-reviewer', '', ['x'], ['**']),
            new RequiredChecklist('b', 'b-reviewer', '', ['x'], ['**']),
        ];
        expect(inst.names(two)).toBe('a-reviewer, b-reviewer');
    });
});
