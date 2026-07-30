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

// The set every message lists. An already-reviewed checklist must NOT reappear: re-instructing it invites a
// redundant second reviewer run and reads as though the earlier verdict did not count.
describe('ReviewJsonService.pendingChecklists', () => {
    const svc2 = new ReviewJsonService();
    const req = (id: string): RequiredChecklist => new RequiredChecklist(id, id, '', ['x.sql'], ['**/*.sql']);

    it('drops the ones that passed and keeps the ones with no verdict', () => {
        const required = [req('a'), req('b')];
        const results = [new ChecklistResult('a', true, 'ok', '')];
        expect(svc2.pendingChecklists(required, results).map((r): string => r.id)).toEqual(['b']);
    });

    it('keeps an un-overridden FAIL (it still owes a passing verdict)', () => {
        const results = [new ChecklistResult('a', false, 'bad', '')];
        expect(svc2.pendingChecklists([req('a')], results).map((r): string => r.id)).toEqual(['a']);
    });

    it('drops an OVERRIDDEN fail — the ship-anyway decision was stated, so it is resolved', () => {
        const results = [new ChecklistResult('a', false, 'bad', 'accepted, tracked in JIRA-1')];
        expect(svc2.pendingChecklists([req('a')], results)).toEqual([]);
    });
});

// The ONE renderer behind wp-checklist, wp-finish's fail-fast, and review.json validation errors.
describe('ChecklistInstructionsService', () => {
    const inst = new ChecklistInstructionsService();
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

    it('inlines the diff command with the real base sha and the authoritative full-file-set path', () => {
        const req = new RequiredChecklist('a', 'a', '', ['x'], ['**']);
        const text = inst.render([req], REVIEW, CTX);
        expect(text).toContain('git diff abc1234 HEAD -- <file>');
        expect(text).toContain('/repo/.webpieces/pr-review/feat/pr-context.json');
    });

    // A truncated list that looks complete is how a reviewer reviews 6 of 40 files and reports success.
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
