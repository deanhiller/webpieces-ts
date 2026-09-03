import { describe, it, expect } from 'vitest';
import { CK_PASS, CK_WARN, CK_OVERRIDDEN, CK_FAIL, CK_MISSING } from '@webpieces/rules-config';
import { ChecklistCommentRenderer, CHECKLIST_COMMENT_MARKER } from './checklist-comment-renderer';
import { ChecklistCommentRow } from './checklist-comment-row';

const renderer = new ChecklistCommentRenderer();
const renderChecklistComment = (
    rows: ChecklistCommentRow[],
    verified: boolean,
    based = true,
): string => renderer.render(rows, verified, based);

// The four files every fixture roster was matched against, so "x of 4" is always honest.
const FOUR_FILES = ['db/003.sql', 'src/a.ts', 'src/b.ts', 'README.md'];

// A reviewer that RAN because one of its two configured globs hit one of the 4 changed files.
function ranRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent, status, detail, true,
        ['db/**', '**/*.sql'], ['**/*.sql'], ['db/003.sql'], FOUR_FILES.length,
    );
}

// A checklist that WAS evaluated and did not apply — its globs hit none of the 4 changed files.
function skippedRow(subagent: string): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent, '', '', false,
        ['apps/web/**', '**/*.tsx'], [], [], FOUR_FILES.length,
    );
}

// A PATTERNLESS checklist: always runs, whole diff in scope. Note it also has NO fired patterns — the same
// empty list a skipped checklist has, which is why the renderer must key off the configured list instead.
function alwaysRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent, status, detail, true, [], [], FOUR_FILES, FOUR_FILES.length,
    );
}

describe('ChecklistCommentRenderer.render — roll-up + full roster', () => {
    it('rolls up X defined / N ran / colors / skipped, and lists EVERY checklist as a checkbox', () => {
        const rows = [
            ranRow('db-reviewer', CK_PASS, 'migrations are reversible'),
            alwaysRow('api-reviewer', CK_WARN, 'adds a route with no rate limit'),
            ranRow('secrets-reviewer', CK_OVERRIDDEN, 'behind a flag; ONE-2210'),
            skippedRow('a11y-reviewer'),
            skippedRow('i18n-reviewer'),
        ];
        const md = renderChecklistComment(rows, true);
        expect(md).toContain(CHECKLIST_COMMENT_MARKER);
        expect(md).toContain('— 5 defined · 3 ran (🟢 1 · 🟡 1 · 🟠 1) · 2 skipped ✅');
        expect(md).toContain('### Checklists (all 5)');
        expect(md).toContain('- [x] 🟢 **db-reviewer** — passed');
        expect(md).toContain('- [x] 🟡 **api-reviewer** — passed with concerns');
        expect(md).toContain('- [x] 🟠 **secrets-reviewer** — OVERRIDDEN');
        expect(md).toContain(
            '- [ ] ⚪ **a11y-reviewer** — skipped, not applicable to this diff (expected ✅)',
        );
        expect(md).toContain('- [ ] ⚪ **i18n-reviewer** — skipped');
    });

    it('says WHY each one matched — the fired globs and the files they hit', () => {
        const md = renderChecklistComment([ranRow('db-reviewer', CK_PASS, 'ok')], true);
        expect(md).toContain('matched `**/*.sql` → 1 of 4 changed file(s): db/003.sql');
    });

    it('says why a SKIPPED one did not match, and never claims the whole diff was in its scope', () => {
        const md = renderChecklistComment([skippedRow('a11y-reviewer')], true);
        expect(md).toContain('`apps/web/**`, `**/*.tsx` matched 0 of 4 changed file(s)');
        expect(md).not.toContain('ALWAYS RUNS');
    });

    it('distinguishes a PATTERNLESS checklist from a skipped one (both fired zero globs)', () => {
        const md = renderChecklistComment([alwaysRow('api-reviewer', CK_PASS, 'ok')], true);
        expect(md).toContain('ALWAYS RUNS (no patterns)');
        expect(md).toContain('whole diff in scope, 4 changed file(s)');
        expect(md).not.toContain('matched 0 of');
        // The line states the fact and stops. Patternless is a deliberate configuration, so the row must
        // NOT tell the repo to "add `patterns` if that is not intended" — that nags every repo that meant
        // it, on every PR, forever.
        expect(md).not.toContain('if that is not intended');
    });

    it('refuses to report an unresolvable diff base as an all-clear', () => {
        const md = renderChecklistComment(
            [skippedRow('a11y-reviewer'), skippedRow('i18n-reviewer')],
            true,
            false,
        );
        expect(md).toContain('⚠️ NOT EVALUATED (2 defined)');
        expect(md).toContain('not** an all-clear');
        expect(md).not.toContain('skipped ✅');
        expect(md).not.toContain('all passed');
    });
});

describe('ChecklistCommentRenderer.render — reviewer sections', () => {
    it('gives each reviewer that RAN a section with its output verbatim, exceptions first', () => {
        const rows = [
            ranRow('db-reviewer', CK_PASS, 'migrations are reversible'),
            alwaysRow('api-reviewer', CK_WARN, 'adds a route with no rate limit'),
            ranRow('secrets-reviewer', CK_OVERRIDDEN, 'behind a flag; ONE-2210'),
        ];
        const md = renderChecklistComment(rows, true);
        expect(md).toContain('### Reviews that ran');
        expect(md).toContain(
            '#### 🟠 secrets-reviewer — OVERRIDDEN — a human authorized shipping it '
            + '(recorded in override-secrets-reviewer.json)',
        );
        expect(md).toContain('#### 🟡 api-reviewer — passed with concerns');
        expect(md).toContain('#### 🟢 db-reviewer — passed');
        expect(md).toContain('adds a route with no rate limit');
        // Overridden → warned → passed: a reader meets what needs attention before the wall of green.
        const sections = md.slice(md.indexOf('### Reviews that ran'));
        expect(sections.indexOf('secrets-reviewer')).toBeLessThan(sections.indexOf('api-reviewer'));
        expect(sections.indexOf('api-reviewer')).toBeLessThan(sections.indexOf('db-reviewer'));
    });

    it('gives NO section (and makes no provenance claim) when nothing had to run', () => {
        const md = renderChecklistComment(
            [skippedRow('a11y-reviewer'), skippedRow('i18n-reviewer')],
            true,
        );
        expect(md).toContain('— 2 defined · 0 ran · 2 skipped ✅');
        expect(md).toContain('No reviewer had to run on this diff');
        expect(md).not.toContain('### Reviews that ran');
        expect(md).not.toContain('verified from the Claude Code harness');
    });

    it('reflects provenance: verified vs unverified', () => {
        const rows = [ranRow('db-reviewer', CK_PASS, 'ok')];
        expect(renderChecklistComment(rows, true)).toContain(
            'verified from the Claude Code harness',
        );
        expect(renderChecklistComment(rows, false)).toContain('provenance was NOT verified');
    });

    it('truncates the LONGEST body to fit the cap, keeping every heading AND the whole roster', () => {
        const rows = [
            ranRow('short-reviewer', CK_PASS, 'tiny note'),
            ranRow('huge-reviewer', CK_PASS, 'x'.repeat(70000)),
            skippedRow('a11y-reviewer'),
        ];
        const md = renderChecklistComment(rows, true);
        expect(md.length).toBeLessThanOrEqual(65000);
        expect(md).toContain('#### 🟢 short-reviewer — passed');
        expect(md).toContain('tiny note'); // short body untouched
        expect(md).toContain('#### 🟢 huge-reviewer — passed');
        expect(md).toContain('truncated to fit'); // long body was cut
        // The roster lives in the header, so no roster line can be the thing an oversize comment drops.
        expect(md).toContain('- [ ] ⚪ **a11y-reviewer** — skipped');
        expect(md).toContain('- [x] 🟢 **huge-reviewer** — passed');
    });
});

describe('ChecklistCommentRenderer.render — optional checklists', () => {
    // Applied to the diff (so `ran` is true in the "this checklist matched" sense) but carrying no verdict:
    // the human was offered this review and said no.
    function declinedRow(subagent: string): ChecklistCommentRow {
        const row = ranRow(subagent, CK_MISSING);
        row.required = false;
        return row;
    }

    function optionalRanRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
        const row = ranRow(subagent, status, detail);
        row.required = false;
        return row;
    }

    it('tags optional checklists so a reader can tell skippable from simply passed', () => {
        const md = renderChecklistComment([ranRow('db-reviewer', CK_PASS, 'ok'), optionalRanRow('fe-reviewer', CK_PASS, 'ok')], true);
        expect(md).toContain('**fe-reviewer** _(optional)_');
        expect(md).not.toContain('**db-reviewer** _(optional)_');
    });

    it('renders a declined optional review as NOT RUN — unchecked, and never as passed', () => {
        const md = renderChecklistComment([ranRow('db-reviewer', CK_PASS, 'ok'), declinedRow('fe-reviewer')], true);
        expect(md).toContain('- [ ] ⚪ **fe-reviewer** _(optional)_ — OPTIONAL — applied to this diff but was NOT run');
        expect(md).toContain('- [x] 🟢 **db-reviewer**');
    });

    // "Not applicable" is the diff's doing; "not run" is a person's. Reporting the second as the first
    // would quietly credit a review nobody performed.
    it('does not call a declined review "skipped, not applicable"', () => {
        const md = renderChecklistComment([declinedRow('fe-reviewer')], true);
        expect(md).not.toContain('not applicable to this diff');
    });

    it('counts declined reviews separately from skipped ones, and without a ✅', () => {
        const md = renderChecklistComment(
            [ranRow('db-reviewer', CK_PASS, 'ok'), declinedRow('fe-reviewer'), skippedRow('ops-reviewer')], true);
        expect(md).toContain('3 defined · 1 ran');
        expect(md).toContain('1 skipped ✅');
        expect(md).toContain('1 optional not run');
        expect(md).not.toContain('2 skipped');
    });

    // It has no `output` to publish, so a section for it would be an empty heading claiming a review.
    it('gives a declined review no reviewer section', () => {
        const md = renderChecklistComment([ranRow('db-reviewer', CK_PASS, 'ok'), declinedRow('fe-reviewer')], true);
        expect(md.indexOf('### Reviews that ran')).toBeGreaterThan(0);
        expect(md.slice(md.indexOf('### Reviews that ran'))).not.toContain('fe-reviewer');
    });

    // THE false all-clear. This exact sentence used to be unconditional.
    it('never claims "none of them applied" when an optional one applied and was declined', () => {
        const md = renderChecklistComment([declinedRow('fe-reviewer'), skippedRow('ops-reviewer')], true);
        expect(md).not.toContain('none of them applied');
        expect(md).toContain('1 OPTIONAL checklist(s) DID apply to this diff and were not run');
    });

    it('keeps the original all-clear wording when nothing was declined', () => {
        const md = renderChecklistComment([skippedRow('ops-reviewer')], true);
        expect(md).toContain('every configured checklist was evaluated and none of them applied');
    });

    // An optional reviewer that RAN is an ordinary reviewer: its verdict counts, and is published in full.
    it('publishes a red verdict from an optional reviewer exactly like any other', () => {
        const md = renderChecklistComment([optionalRanRow('fe-reviewer', CK_FAIL, 'unbounded list render')], true);
        expect(md).toContain('- [x] 🔴 **fe-reviewer** _(optional)_ — FAILED review');
        expect(md).toContain('unbounded list render');
    });
});
