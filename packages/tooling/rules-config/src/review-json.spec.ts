import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadReviewJson, prDirFor, reviewJsonPath, reviewJsonSchemaHint, RequiredChecklist, ChecklistResult, ChecklistReviewContext, ReviewJsonService, PrContext } from './review-json';
import { ChecklistInstructionsService } from './checklist-instructions';
import { WEBPIECES_TMP_DIR, PR_REVIEW_DIR } from './constants';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

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

/**
 * Archiving is the STALE half of the same bug as the stage-② reordering: a review.json left in place after
 * a PR is posted is a live-looking file describing a review that already shipped, and the next stage-② run
 * on the branch finds it there. A reviewer whose checklist judges the PR's stated intent then validates the
 * PREVIOUS round's title and returns GREEN on content that no longer exists. The move is what makes that
 * impossible; the note is what stops the archive being copied forward as if it were current.
 */
describe('archiveReviewJson', () => {
    const svc = new ReviewJsonService();
    const aReview = (title: string): string => JSON.stringify({
        title, riskScore: 10, riskLevel: 'green', summary: 's', violations: [], risks: [], filesToReview: [],
    });

    it('moves review.json to old-review.json — the original no longer exists', () => {
        const file = tmpFile(aReview('First round'));
        const archived = svc.archiveReviewJson(file);
        expect(archived).toBe(path.join(path.dirname(file), 'old-review.json'));
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(archived)).toBe(true);
    });

    it('stamps the audit-only note as the FIRST key, ahead of the review content', () => {
        const file = tmpFile(aReview('First round'));
        const body = fs.readFileSync(svc.archiveReviewJson(file), 'utf8');
        const keys = Object.keys(JSON.parse(body) as Record<string, unknown>);
        expect(keys[0]).toBe('_ARCHIVED_AUDIT_ONLY');
        expect(keys).toContain('title');
        expect(body).toContain('AUDIT');
        expect(body).toContain('write a FRESH review.json');
    });

    it('preserves the reviewed content so the archive is usable as an audit trail', () => {
        const file = tmpFile(aReview('First round'));
        const parsed = JSON.parse(fs.readFileSync(svc.archiveReviewJson(file), 'utf8')) as Record<string, unknown>;
        expect(parsed['title']).toBe('First round');
        expect(parsed['riskLevel']).toBe('green');
    });

    // Always the same path — the archive holds the LAST review and only the last one, never a series.
    it('overwrites a previous archive rather than accumulating files', () => {
        const first = tmpFile(aReview('First round'));
        const dir = path.dirname(first);
        svc.archiveReviewJson(first);
        fs.writeFileSync(first, aReview('Second round'));
        svc.archiveReviewJson(first);
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'old-review.json'), 'utf8')) as Record<string, unknown>;
        expect(parsed['title']).toBe('Second round');
        expect(fs.readdirSync(dir)).toEqual(['old-review.json']);
    });

    it('is a no-op when there is nothing to archive', () => {
        const file = tmpFile(aReview('gone'));
        fs.rmSync(file);
        expect(svc.archiveReviewJson(file)).toBe('');
    });

    // THE point of the whole thing: after a finish, the next round cannot silently reuse the old review.
    it('leaves the branch unable to reach finish again without a fresh review', () => {
        const file = tmpFile(aReview('First round'));
        svc.archiveReviewJson(file);
        expect((): unknown => loadReviewJson(file)).toThrow(InformAiError);
    });

    it('points the "not found" complaint at the archive instead of reading as data loss', () => {
        const file = tmpFile(aReview('First round'));
        svc.archiveReviewJson(file);
        // webpieces-disable no-unmanaged-exceptions -- the assertion IS the thrown message
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            loadReviewJson(file);
            expect.fail('expected loadReviewJson to refuse');
        } catch (err: unknown) {
            const error = toError(err);
            expect(error.message).toContain('old-review.json');
            expect(error.message).toContain('AUDIT ONLY');
        }
    });

    it('says nothing about an archive when none was ever written', () => {
        const file = tmpFile(aReview('x'));
        fs.rmSync(file);
        // webpieces-disable no-unmanaged-exceptions -- the assertion IS the thrown message
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            loadReviewJson(file);
            expect.fail('expected loadReviewJson to refuse');
        } catch (err: unknown) {
            const error = toError(err);
            expect(error.message).not.toContain('old-review.json');
        }
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
        const p = svc.writePrContext(repo, 'feat', new PrContext(
            'base123', 'head456', ['a.ts', 'db/1.sql'],
            true, ['a.ts'], 'git diff base123', '/repo/diff', '2026-07-30T00:00:00.000Z'));
        expect(p).toBe(svc.prContextPath(repo, 'feat'));
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(parsed).toEqual({
            base: 'base123',
            // A real sha, NOT the literal 'HEAD'. 'HEAD' is not a fact: it cannot be compared later to
            // detect that the tree moved under a review, which is what the stage-② receipt needs.
            head: 'head456',
            changedFiles: ['a.ts', 'db/1.sql'],
            // Recorded so a reviewer is never handed a range that silently excludes uncommitted work.
            dirty: true,
            dirtyFiles: ['a.ts'],
            diffCommand: 'git diff base123',
            diffDir: '/repo/diff',
            generatedAt: '2026-07-30T00:00:00.000Z',
            // Point C of the same trio the 3-point merge records. Without it nothing downstream can
            // answer "did main move while this branch was under review?".
            hashMainHead: '',
        });
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
    // ChecklistInstructionsService (one renderer, shared by wp-review-upsert-pr / wp-finish / this file's errors) —
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

// The ONE renderer behind wp-review-upsert-pr, wp-finish's fail-fast, and review.json validation errors.
describe('ChecklistInstructionsService', () => {
    const inst = new ChecklistInstructionsService(new ReviewJsonService());
    // A CLEAN-tree context: base→head, both real shas. The command is GIVEN, never assembled here — see
    // the dirty-tree regression test below for why that distinction is the whole point.
    const CTX = new ChecklistReviewContext(
        'abc1234', '/repo/.webpieces/pr-review/feat/pr-context.json', 'git diff abc1234 def5678 -- <file>');
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

    it('inlines the diff command it was GIVEN, and the authoritative full-file-set path', () => {
        const req = new RequiredChecklist('a', 'a', '', ['x'], ['**']);
        const text = inst.render([req], REVIEW, CTX);
        expect(text).toContain('git diff abc1234 def5678 -- <file>');
        expect(text).toContain('/repo/.webpieces/pr-review/feat/pr-context.json');
    });

});

// Split out to keep each describe under the method-length limit. These are the diff-command tests: the
// renderer must print the command it was GIVEN, never re-assemble `<base> HEAD`.
describe('ChecklistInstructionsService — the diff command', () => {
    const inst = new ChecklistInstructionsService(new ReviewJsonService());
    const REVIEW = '/repo/.webpieces/pr-review/feat/review.json';

    /**
     * THE regression test for the recorded failure.
     *
     * This renderer used to hand-assemble `git diff <baseSha> HEAD -- <file>`. On a dirty tree that range is
     * empty — the changed-FILE set is computed base→working-tree — so a reviewer was handed a file list and
     * a command that showed it nothing. A real reviewer subagent ran that command, got no output, and had
     * to guess its way to `git diff HEAD`.
     *
     * The command must therefore come from the basis that produced the file set, and a dirty one must carry
     * NO head. Asserting the absence of ` HEAD ` is the point: that token reappearing IS the bug.
     */
    it('prints the dirty-tree command with NO head, and never re-assembles `<base> HEAD`', () => {
        const dirty = new ChecklistReviewContext(
            'abc1234', '/repo/.webpieces/pr-review/feat/pr-context.json', 'git diff abc1234 -- <file>', '', true);
        const text = inst.render([new RequiredChecklist('a', 'a', '', ['x'], ['**'])], REVIEW, dirty);
        expect(text).toContain('git diff abc1234 -- <file>');
        expect(text).not.toContain('git diff abc1234 HEAD');
        // …and it must SAY the diff includes uncommitted work, so the reviewer knows what it is judging.
        expect(text).toContain('INCLUDES uncommitted');
    });

    // A materialized diff is one Read instead of a shell-out per file, so it leads when it exists.
    it('points at the extracted diff when one was materialized', () => {
        const withDiff = new ChecklistReviewContext(
            'abc1234', '/repo/ctx.json', 'git diff abc1234 def5678 -- <file>', '/repo/.webpieces/pr-review/feat/diff');
        const text = inst.render([new RequiredChecklist('a', 'a', '', ['x'], ['**'])], REVIEW, withDiff);
        expect(text).toContain('/repo/.webpieces/pr-review/feat/diff/ALL.diff');
        expect(text).toContain('manifest.json');
    });

    // An older pr-gate wrote a context with no command. Guessing `<base> HEAD` to fill the gap would
    // resurrect the exact bug above, so the gap is stated instead.
    it('states a missing reproduce command rather than inventing one', () => {
        const noCmd = new ChecklistReviewContext('abc1234', '/repo/ctx.json');
        const text = inst.render([new RequiredChecklist('a', 'a', '', ['x'], ['**'])], REVIEW, noCmd);
        expect(text).toContain('no reproduce command recorded');
        expect(text).not.toContain('git diff abc1234 HEAD');
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

/**
 * The verdict-file half of the archiving story. `review.json` already gets a one-generation archive; its
 * siblings got none, so the healthy workflow — reviewer refuses → author fixes it → reviewer re-runs and
 * passes — ERASED the refusal by writing over the same path. The refusal is the interesting event and the
 * pass is the expected one, so the tree ended up keeping exactly the wrong half.
 */
describe('archiveChecklistResult', () => {
    const svc = new ReviewJsonService();
    // A real ChecklistResult, not an object literal (CLAUDE.md), serialized by tmpReviewWith.
    const redVerdict = (output: string): ChecklistResult => new ChecklistResult('migrations', 'red', output, '');

    it('moves a red verdict to review-<id>.json.old — the live file no longer exists', () => {
        const file = tmpReviewWith({ migrations: redVerdict('NOT NULL without backfill') });
        const archived = svc.archiveChecklistResult(file, 'migrations');
        expect(archived).toBe(path.join(path.dirname(file), 'review-migrations.json.old'));
        expect(fs.existsSync(svc.checklistResultPath(file, 'migrations'))).toBe(false);
        const parsed = JSON.parse(fs.readFileSync(archived, 'utf8')) as Record<string, unknown>;
        expect(parsed['status']).toBe('red');
        expect(parsed['output']).toBe('NOT NULL without backfill');
    });

    it('stamps the audit-only note as the FIRST key, saying it is not a live verdict', () => {
        const file = tmpReviewWith({ migrations: redVerdict('bad') });
        const body = fs.readFileSync(svc.archiveChecklistResult(file, 'migrations'), 'utf8');
        const keys = Object.keys(JSON.parse(body) as Record<string, unknown>);
        expect(keys[0]).toBe('_ARCHIVED_AUDIT_ONLY');
        expect(keys).toContain('status');
        expect(body).toContain('audit');
        expect(body).toContain('NOT a live verdict');
    });

    /**
     * ONE slot is the design. An accumulating `.old.old` series is the failure mode being avoided: it reads
     * as though the NUMBER of retirements meant something, and nothing downstream can interpret that.
     */
    it('overwrites the .old on a second cycle — no .old.old, and the newer body wins', () => {
        const file = tmpReviewWith({ migrations: redVerdict('first refusal') });
        const dir = path.dirname(file);
        svc.archiveChecklistResult(file, 'migrations');
        fs.writeFileSync(svc.checklistResultPath(file, 'migrations'), JSON.stringify(redVerdict('second refusal')));
        svc.archiveChecklistResult(file, 'migrations');
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'review-migrations.json.old'), 'utf8')) as Record<string, unknown>;
        expect(parsed['output']).toBe('second refusal');
        expect(fs.existsSync(path.join(dir, 'review-migrations.json.old.old'))).toBe(false);
        expect(fs.readdirSync(dir).sort()).toEqual(['review-migrations.json.old', 'review.json']);
    });

    it('is a no-op returning "" when there is no live verdict to retire', () => {
        const file = tmpReviewWith({});
        expect(svc.archiveChecklistResult(file, 'migrations')).toBe('');
        expect(fs.readdirSync(path.dirname(file))).toEqual(['review.json']);
    });

    // The archive exists to BE the record, so unstampable bytes are kept verbatim rather than dropped.
    it('archives non-object / unparseable verdict bytes verbatim rather than losing them', () => {
        const file = tmpReviewWith({});
        fs.writeFileSync(svc.checklistResultPath(file, 'migrations'), '{ half-writ');
        expect(fs.readFileSync(svc.archiveChecklistResult(file, 'migrations'), 'utf8')).toBe('{ half-writ');
    });

    /**
     * THE containment guarantee for the move. `loadChecklistResults` looks up the exact `review-<id>.json`
     * name, never a scan of the directory — so a retired refusal sitting right beside the live path can
     * never be handed back as the current state, which would undo the entire point of retiring it.
     */
    it('loadChecklistResults ignores a .old file beside it — with no live file it is still MISSING', () => {
        const file = tmpReviewWith({ migrations: redVerdict('refused') });
        svc.archiveChecklistResult(file, 'migrations');
        expect(svc.loadChecklistResults(file, [REQ('migrations')])).toEqual([]);
        expect(() => loadReviewJson(file, [REQ('migrations')])).toThrowError(/has no verdict/);
    });
});

// A refusal is a RESULT, not a missing step. These two exist so every command says so in the same words —
// when "refused" was computed ad hoc it merged with "never ran" and produced "you MUST run these N reviewer
// subagent(s)", which an AI obeys by re-spawning a reviewer that already answered, forever.
describe('refusedChecklists / refusalError', () => {
    const svc = new ReviewJsonService();
    const req = (id: string): RequiredChecklist => new RequiredChecklist(id, `${id}-reviewer`, '', ['x.sql'], ['**/*.sql']);

    it('selects exactly the CK_FAIL ones — not MISSING, BAD_FORMAT, WARN, PASS or OVERRIDDEN', () => {
        const required = [req('failed'), req('missing'), req('bad'), req('warn'), req('pass'), req('over')];
        const results = [
            new ChecklistResult('failed', 'red', 'refused', ''),
            new ChecklistResult('bad', '', 'ok', '', 'uses the removed "success" field'),
            new ChecklistResult('warn', 'yellow', 'a concern', ''),
            new ChecklistResult('pass', 'green', 'ok', ''),
            new ChecklistResult('over', 'red', 'refused', 'accepted, tracked in JIRA-1'),
        ];
        expect(svc.refusedChecklists(required, results).map((r): string => r.id)).toEqual(['failed']);
    });

    it('quotes the reviewer\'s own output — the finding is the whole point', () => {
        const results = [new ChecklistResult('a', 'red', 'gate 1: title names no ticket', '')];
        const text = svc.refusalError(req('a'), svc.resolveVerdict(req('a'), results));
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
        const text = svc.refusalError(req('a'), svc.resolveVerdict(req('a'), results), archived);
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
            loadReviewJson(file, [REQ('migrations')]);
            expect.fail('expected loadReviewJson to refuse');
        } catch (err: unknown) {
            const error = toError(err);
            expect(error.message).toContain('FAILED review (status:"red")');
            expect(error.message).toContain('NOT NULL without backfill');
            expect(error.message).toContain('set a non-empty "override" in review-migrations.json');
            expect(error.message).not.toContain('RETIRED');
        }
    });
});
