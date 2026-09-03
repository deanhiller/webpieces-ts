import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistOverride, ChecklistOverrideService } from './checklist-override';

/**
 * `override-<id>.json` is the file that gave the human's ship-anyway decision a REACHABLE WRITER. While it
 * was a field inside `review-<id>.json`, the coordinating agent — the only participant that actually hears
 * the human — could not record what it heard, because editing a reviewer's verdict file is refused; and the
 * reviewer subagent refuses to write its own override, correctly. So a human hand-edited JSON.
 */
function dirWithOverride(id: string, body: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-override-'));
    fs.writeFileSync(path.join(dir, `override-${id}.json`), JSON.stringify(body));
    return path.join(dir, 'review.json');
}

const SVC = new ChecklistOverrideService();

describe('ChecklistOverrideService.load', () => {
    it('reads who authorized it, when, and their own words', () => {
        const reviewPath = dirWithOverride('db-reviewer',
            new ChecklistOverride('db-reviewer', 'human, in-session', '2026-09-03T18:22:11Z', 'part B ships alone'));
        const loaded = SVC.load(reviewPath, 'db-reviewer');
        expect(loaded?.reason).toBe('part B ships alone');
        expect(loaded?.authorizedBy).toBe('human, in-session');
        expect(loaded?.authorizedAt).toBe('2026-09-03T18:22:11Z');
        expect(loaded?.problem).toBe('');
    });

    it('is null when no authorization exists — the gate then refuses, which is the safe direction', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-override-none-'));
        expect(SVC.load(path.join(dir, 'review.json'), 'db-reviewer')).toBeNull();
    });

    /**
     * A file that EXISTS but cannot be read is NOT the same as no file. Both refuse the PR, but only one of
     * them means "nobody authorized anything" — and telling a writer their decision was never recorded, when
     * in fact it was recorded badly, sends them to ask the human again for a decision already made.
     */
    it('reports unreadable bytes through `problem` rather than reading as "never authorized"', () => {
        const notAnObject = SVC.load(dirWithOverride('db-reviewer', 'not-an-object'), 'db-reviewer');
        expect(notAnObject?.problem).toContain('not a JSON object');
        expect(notAnObject?.problem).toContain('override-db-reviewer.json');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-override-bad-'));
        fs.writeFileSync(path.join(dir, 'override-db-reviewer.json'), '{ not json');
        const unparseable = SVC.load(path.join(dir, 'review.json'), 'db-reviewer');
        expect(unparseable?.problem).toContain('cannot be read');
        expect(unparseable?.problem).toContain("cat > ");
    });

    /**
     * A missing field is reported, never silently ignored: an authorization with no stated reason and no
     * named authorizer is an ASSERTION rather than a record, and that assertion is exactly what the file
     * replaced. Reporting it is also the difference between "your decision did not count, here is why" and
     * "the human never authorized anything".
     */
    it('reports a missing reason or authorizer through `problem`, and reprints the command', () => {
        const reviewPath = dirWithOverride('db-reviewer',
            new ChecklistOverride('db-reviewer', '', '2026-09-03T18:22:11Z', ''));
        const loaded = SVC.load(reviewPath, 'db-reviewer');
        expect(loaded?.problem).toContain('"authorizedBy" and "reason"');
        expect(loaded?.problem).toContain('override-db-reviewer.json');
        expect(loaded?.problem).toContain("cat > ");
    });
});

describe('ChecklistOverrideService.writeCommand', () => {
    const REVIEW = '/repo/.webpieces/pr-review/feat/review.json';

    it('is a complete, copy-pasteable heredoc with the real id and path', () => {
        const cmd = SVC.writeCommand(REVIEW, 'backwards-compat-reviewer');
        expect(cmd.startsWith(
            "cat > /repo/.webpieces/pr-review/feat/override-backwards-compat-reviewer.json <<'JSON'")).toBe(true);
        expect(cmd).toContain('"checklistId": "backwards-compat-reviewer"');
        expect(cmd).toContain('"authorizedBy": "human, in-session"');
        // The closing delimiter must be at column 0, or the pasted command hangs the shell.
        expect(cmd.endsWith('\nJSON')).toBe(true);
    });

    it('leaves ONLY the reason as a fill-in — everything else is already correct', () => {
        const cmd = SVC.writeCommand(REVIEW, 'db-reviewer');
        expect(cmd).toContain("REPLACE THIS with the human's own words, verbatim");
        // authorizedAt comes from the clock, not from the reader.
        expect(cmd).toMatch(/"authorizedAt": "\d{4}-\d{2}-\d{2}T/);
    });

    /**
     * NO DIGEST, NO EXPIRY, NO SCOPING. An earlier draft hashed the reviewer's `output` so an override would
     * lapse when the finding changed. `output` is LLM-written prose, so a re-run rewords the SAME finding
     * almost every time — the hash would have lapsed on essentially every re-review, which is the
     * re-authorization dance this whole file exists to delete. Freshness is carried by transparency instead.
     */
    it('carries no digest, no expiry and no branch or sha scoping', () => {
        const cmd = SVC.writeCommand(REVIEW, 'db-reviewer');
        expect(cmd).not.toContain('findingDigest');
        expect(cmd).not.toContain('expires');
        expect(cmd).not.toContain('branch');
        expect(cmd).not.toContain('sha');
    });
});

describe('ChecklistOverrideService.writerRule', () => {
    // The half of this feature that is MESSAGING. The old refusal said what to write and where, never who
    // may — which is why a reviewer subagent once told a human to run a command that no longer shipped.
    it('names the coordinating agent, and rules out both self-authorization and a relay', () => {
        const rule = SVC.writerRule();
        expect(rule).toContain('COORDINATING agent');
        expect(rule).toContain('NOT self-authorization');
        expect(rule).toContain('NOT consent');
        expect(rule).toContain('STOP');
    });

    // No message anywhere may teach a command this release does not ship. `wp-authorize` and `wp-check-auth`
    // were deleted outright; a cure naming either is unfollowable.
    it('never names a deleted command', () => {
        const text = SVC.writerRule() + SVC.writeCommand('/r/review.json', 'a');
        expect(text).not.toContain('wp-authorize');
        expect(text).not.toContain('wp-check-auth');
    });
});

describe('ChecklistOverrideService.detail', () => {
    it('renders the reason WITH its provenance, so nothing is taken on trust', () => {
        const detail = SVC.detail(
            new ChecklistOverride('a', 'human, in-session', '2026-09-03T18:22:11Z', 'part B ships alone'));
        expect(detail).toBe('part B ships alone (authorized by human, in-session, 2026-09-03T18:22:11Z)');
    });
});
