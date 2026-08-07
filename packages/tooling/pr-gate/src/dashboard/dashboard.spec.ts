import { describe, it, expect } from 'vitest';
import { GateDefinition, ReviewJson } from '@webpieces/rules-config';
import {
    Dashboard,
    DashboardInput,
    GateResult,
    DisableCounts,
    ChecklistRow,
    CHECKLIST_COMMENT_MARKER,
} from './dashboard';
import { CK_PASS, CK_WARN, CK_OVERRIDDEN, CK_FAIL, CK_MISSING } from '@webpieces/rules-config';
import { ChecklistCommentRow } from './checklist-comment-row';

const dash = new Dashboard();
const computeGateResults = (g: GateDefinition[], f: string[]): GateResult[] =>
    dash.computeGateResults(g, f);
const countAddedDisables = (p: string): DisableCounts => dash.countAddedDisables(p);
const renderDashboard = (i: DashboardInput): string => dash.renderDashboard(i);
const renderCommitBody = (i: DashboardInput, url: string): string => dash.renderCommitBody(i, url);

function review(overrides: Partial<ReviewJson> = {}): ReviewJson {
    const base = new ReviewJson('A short title', 20, 'green', '🟢', 'A short summary.', [], [], []);
    return Object.assign(base, overrides);
}

const renderChecklistComment = (
    rows: ChecklistCommentRow[],
    verified: boolean,
    based = true,
): string => dash.renderChecklistComment(rows, verified, based);

// The four files every fixture roster was matched against, so "x of 4" is always honest.
const FOUR_FILES = ['db/003.sql', 'src/a.ts', 'src/b.ts', 'README.md'];

// A reviewer that RAN because one of its two configured globs hit one of the 4 changed files.
function ranRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent,
        status,
        detail,
        true,
        ['db/**', '**/*.sql'],
        ['**/*.sql'],
        ['db/003.sql'],
        FOUR_FILES.length,
    );
}

// A checklist that WAS evaluated and did not apply — its globs hit none of the 4 changed files.
function skippedRow(subagent: string): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent,
        '',
        '',
        false,
        ['apps/web/**', '**/*.tsx'],
        [],
        [],
        FOUR_FILES.length,
    );
}

// A PATTERNLESS checklist: always runs, whole diff in scope. Note it also has NO fired patterns — the same
// empty list a skipped checklist has, which is why the renderer must key off the configured list instead.
function alwaysRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent,
        status,
        detail,
        true,
        [],
        [],
        FOUR_FILES,
        FOUR_FILES.length,
    );
}

describe('renderChecklistComment — roll-up + full roster', () => {
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

describe('renderChecklistComment — reviewer sections', () => {
    it('gives each reviewer that RAN a section with its output verbatim, exceptions first', () => {
        const rows = [
            ranRow('db-reviewer', CK_PASS, 'migrations are reversible'),
            alwaysRow('api-reviewer', CK_WARN, 'adds a route with no rate limit'),
            ranRow('secrets-reviewer', CK_OVERRIDDEN, 'behind a flag; ONE-2210'),
        ];
        const md = renderChecklistComment(rows, true);
        expect(md).toContain('### Reviews that ran');
        expect(md).toContain(
            '#### 🟠 secrets-reviewer — OVERRIDDEN — shipped with a stated justification',
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

describe('computeGateResults', () => {
    it('matches glob patterns and reports matched files', () => {
        const gates = [
            new GateDefinition('API Changed', ['libraries/apis/**', '**/*Api.ts'], 'yellow'),
            new GateDefinition('Schema', ['db/schema.sql'], 'red'),
        ];
        const changed = ['libraries/apis/Foo.ts', 'src/x/BarApi.ts', 'src/util.ts'];
        const results = computeGateResults(gates, changed);

        expect(results[0].matchedFiles).toEqual(['libraries/apis/Foo.ts', 'src/x/BarApi.ts']);
        expect(results[1].matchedFiles).toEqual([]);
    });

    it('skips disabled (example) gates entirely', () => {
        const gates = [
            new GateDefinition('Active', ['**/*Api.ts'], 'yellow'),
            new GateDefinition('Example DB', ['**/*Api.ts'], 'red', true),
        ];
        const results = computeGateResults(gates, ['src/FooApi.ts']);
        expect(results.map((r): string => r.name)).toEqual(['Active']);
    });
});

describe('countAddedDisables', () => {
    it('counts only ADDED disable lines and reports webpieces rules', () => {
        const patch = [
            '+++ b/src/a.ts',
            '+// webpieces-disable no-any-unknown -- reason',
            '+const x = 1;',
            '-// webpieces-disable catch-error-pattern -- removed line (not counted)',
            '+  // eslint-disable-next-line foo',
            ' unchanged webpieces-disable no-destructure (context line, not counted)',
        ].join('\n');
        const counts = countAddedDisables(patch);

        expect(counts.webpiecesCount).toBe(1);
        expect(counts.webpiecesRules).toEqual(['no-any-unknown']);
        expect(counts.eslintCount).toBe(1);
    });
});

describe('renderDashboard', () => {
    it('renders the RISK section, yellow gates, and build status', () => {
        const gates = computeGateResults(
            [new GateDefinition('API Changed', ['**/*Api.ts'], 'yellow')],
            ['src/FooApi.ts'],
        );
        const disables = countAddedDisables('');
        const input = new DashboardInput(
            'My PR',
            gates,
            disables,
            true,
            'aaaaaaaaaaaa',
            'bbbbbbbbbbbb',
            'cccccccccccc',
            review({ riskScore: 20, riskLevel: 'green', riskEmoji: '🟢' }),
        );
        const md = renderDashboard(input);

        expect(md).toContain('🚦 PR Gate Dashboard');
        expect(md).toContain('**Risk Score:**');
        expect(md).toContain('**20/100** 🟢');
        expect(md).toContain('**Risk Level:** 🟢 **green**');
        expect(md).toContain('**Pattern Violations:** 🟢 No');
        expect(md).toContain('**Build (nx affected):** 🟢 Passed');
        expect(md).toContain('**API Changed:** 🟡 Yes (1 file(s))');
        expect(md).toContain('### Summary');
        expect(md).toContain('Fork point (A): `aaaaaaaaaaaa`');
    });

    it('renders a red gate with 🔴 and counts pattern violations', () => {
        const gates = computeGateResults(
            [new GateDefinition('DB Schema Changed', ['db/schema.sql'], 'red')],
            ['db/schema.sql'],
        );
        const input = new DashboardInput(
            'My PR',
            gates,
            countAddedDisables(''),
            true,
            'a',
            'b',
            'c',
            review({
                riskScore: 80,
                riskLevel: 'red',
                riskEmoji: '🔴',
                violations: ['boundary crossed', 'naming'],
            }),
        );
        const md = renderDashboard(input);

        expect(md).toContain('**DB Schema Changed:** 🔴 Yes (1 file(s))');
        expect(md).toContain('**Risk Level:** 🔴 **red**');
        expect(md).toContain('**Pattern Violations:** 🟡 Yes (2 violation(s))');
    });
});

describe('renderCommitBody', () => {
    it('leads with the PR link, then the risk score, omitting green rows', () => {
        const input = new DashboardInput(
            'My PR',
            computeGateResults([], []),
            countAddedDisables(''),
            true,
            'a',
            'b',
            'c',
            review({
                riskScore: 20,
                riskLevel: 'green',
                riskEmoji: '🟢',
                summary: 'One thing. Two thing. Three thing.',
            }),
        );
        const body = renderCommitBody(input, 'https://github.com/o/r/pull/42');

        // ORDER is the point, not mere presence: the link is the FIRST line of the body, so `git log`
        // shows it directly under the subject. Assert with startsWith + index comparison — a `toContain`
        // pair would have passed just as happily with the link back at the bottom.
        expect(body.startsWith('https://github.com/o/r/pull/42\n')).toBe(true);
        expect(body.indexOf('https://github.com/o/r/pull/42')).toBeLessThan(body.indexOf('Risk: '));
        expect(body).toContain('20/100 🟢 (green)');
        expect(body).toContain('Flags: 🟢 all green');
        expect(body).toContain('One thing. Two thing. Three thing.');
        // The old `PR: <url>` label is gone — the bare URL leads instead.
        expect(body).not.toContain('PR: ');
    });

    it('lists every non-green flag (build, gates, violations, disables)', () => {
        const gates = computeGateResults(
            [new GateDefinition('API Changed', ['**/*Api.ts'], 'yellow')],
            ['src/FooApi.ts'],
        );
        const disables = countAddedDisables(
            [
                '+++ b/a.ts',
                '+// webpieces-disable no-any-unknown -- x',
                '+// eslint-disable-next-line',
            ].join('\n'),
        );
        const input = new DashboardInput(
            'My PR',
            gates,
            disables,
            false,
            'a',
            'b',
            'c',
            review({ riskScore: 80, riskLevel: 'red', riskEmoji: '🔴', violations: ['boundary'] }),
        );
        const body = renderCommitBody(input, '');

        expect(body).toContain('Flags (non-green):');
        expect(body).toContain('- Build (nx affected): 🔴 Failed');
        expect(body).toContain('- Pattern Violations: 🟡 1 violation(s)');
        expect(body).toContain('- API Changed: 🟡 1 file(s)');
        expect(body).toContain('- Webpieces Disables Added: 🟡 1 line(s) — no-any-unknown');
        expect(body).toContain('- ESLint Disables Added: 🟡 1 line(s)');
        // No URL to lead with → the body starts at the risk line, with no stray blank first line.
        expect(body.startsWith('Risk: ')).toBe(true);
        expect(body).not.toContain('https://');
    });

    it('caps the summary at 4 sentences', () => {
        const input = new DashboardInput(
            'My PR',
            computeGateResults([], []),
            countAddedDisables(''),
            true,
            'a',
            'b',
            'c',
            review({ summary: 'S1. S2. S3. S4. S5. S6.' }),
        );
        const body = renderCommitBody(input, '');

        expect(body).toContain('S1. S2. S3. S4.');
        expect(body).not.toContain('S5.');
    });

    it('does not drop text or split on interior dots in filenames/paths/versions', () => {
        const input = new DashboardInput(
            'My PR',
            computeGateResults([], []),
            countAddedDisables(''),
            true,
            'a',
            'b',
            'c',
            review({
                summary:
                    'Edits dependencies.json and runtime-graph.ts under src/lib. Bumps to 0.4.447 cleanly.',
            }),
        );
        const body = renderCommitBody(input, '');

        // Both real sentences survive intact — the dotted tokens are NOT treated as sentence breaks and
        // no prose is silently discarded.
        expect(body).toContain('Edits dependencies.json and runtime-graph.ts under src/lib.');
        expect(body).toContain('Bumps to 0.4.447 cleanly.');
    });
});

// The ~90-word override paragraph that used to be inlined on EVERY per-checklist dashboard row.
const OVERRIDE_PROSE =
    'HUMAN-APPROVED OVERRIDE (Dean Hiller, explicit, in-session). This branch is a THROWAWAY pr-gate ' +
    'smoke test and is NOT for merge - the defects below were planted deliberately. Delete this branch ' +
    'after the layout has been eyeballed.';

function dashboardWith(rows: ChecklistRow[]): string {
    const input = new DashboardInput(
        'My PR',
        computeGateResults([], []),
        countAddedDisables(''),
        true,
        'a',
        'b',
        'c',
        review(),
        rows,
    );
    return renderDashboard(input);
}

describe('renderDashboard checklists — ONE rolled-up row', () => {
    // Nobody looked is NOT an all-clear. A green row (or, as before, no row at all) reads as "checked and
    // clean"; ⚪ says no reviewer was involved, which is precisely what a reader must be able to tell apart.
    it('renders a SKIPPED ⚪ row — never green, never nothing — when no checklist ran', () => {
        const input = new DashboardInput(
            'My PR',
            computeGateResults([], []),
            countAddedDisables(''),
            true,
            'a',
            'b',
            'c',
            review(),
        );
        const md = renderDashboard(input);
        expect(md).toContain(
            '**Checklists:** ⚪ 0 ran — no review checklist matched this PR · see the checklist comment',
        );
        expect(md).not.toContain('**Checklists:** 🟢');
        expect(md).not.toContain('Checklist —'); // and no per-checklist row survives anywhere
    });

    // The bug this row replaced: six checklists meant six rows, each repeating the SAME override paragraph.
    it('collapses six overridden checklists into ONE orange row with a count and NO override prose', () => {
        const ids = [
            'morpheus-envvars',
            'morpheus-frontend',
            'morpheus-db',
            'morpheus-api',
            'morpheus-infra',
            'morpheus-a11y',
        ];
        const md = dashboardWith(
            ids.map(
                (id: string): ChecklistRow => new ChecklistRow(id, CK_OVERRIDDEN, OVERRIDE_PROSE),
            ),
        );

        expect(md).toContain(
            '**Checklists:** 🟠 6 ran — 6 overridden (morpheus-envvars, morpheus-frontend, ' +
                'morpheus-db, morpheus-api +2 more) · per-checklist detail in the checklist comment',
        );
        expect(md.match(/\*\*Checklists:\*\*/g)).toHaveLength(1);
        expect(md).not.toContain('HUMAN-APPROVED OVERRIDE');
        expect(md).not.toContain('THROWAWAY');
        expect(md).not.toContain('override:');
    });

    it('is GREEN and says all passed when every checklist passed', () => {
        const md = dashboardWith([
            new ChecklistRow('db-reviewer', CK_PASS),
            new ChecklistRow('api-reviewer', CK_PASS),
        ]);
        expect(md).toContain(
            '**Checklists:** 🟢 2 ran — all passed · per-checklist detail in the checklist comment',
        );
    });

    // Worst-of: red beats orange beats yellow beats green, and the row names who is red.
    it('is RED when any checklist is blocking, even amid overrides and passes', () => {
        const md = dashboardWith([
            new ChecklistRow('db-reviewer', CK_PASS),
            new ChecklistRow('api-reviewer', CK_WARN, 'no rate limit'),
            new ChecklistRow('secrets-reviewer', CK_OVERRIDDEN, OVERRIDE_PROSE),
            new ChecklistRow('infra-reviewer', CK_FAIL, 'the Dockerfile is never built'),
        ]);
        expect(md).toContain(
            '**Checklists:** 🔴 4 ran — 1 blocking (infra-reviewer), 1 overridden ' +
                '(secrets-reviewer), 1 with concerns (api-reviewer), 1 passed · per-checklist detail in the checklist comment',
        );
        expect(md).not.toContain('Dockerfile');
    });

    // An override is a human knowingly accepting a RED verdict — it must never render as a clean pass.
    it('is ORANGE (never green) for an override, and YELLOW for a warn-only run', () => {
        expect(
            dashboardWith([
                new ChecklistRow('hasura-reviewer', CK_OVERRIDDEN, 'behind a flag; ONE-2210'),
            ]),
        ).toContain('**Checklists:** 🟠 1 ran — 1 overridden (hasura-reviewer)');
        expect(
            dashboardWith([
                new ChecklistRow('api-reviewer', CK_WARN, 'no rate limit on the new route'),
            ]),
        ).toContain('**Checklists:** 🟡 1 ran — 1 with concerns (api-reviewer)');
    });

    // An unrecognized verdict is BLOCKING, not a silent pass — the same default the comment side uses.
    it('treats an unknown verdict as blocking rather than green', () => {
        expect(dashboardWith([new ChecklistRow('mystery-reviewer', 'brand-new-state')])).toContain(
            '**Checklists:** 🔴 1 ran — 1 blocking (mystery-reviewer)',
        );
    });
});

describe('renderDashboard checklists — the detail still lives in the comment', () => {
    // The roll-up row is a SUMMARY, not a replacement: the comment is unchanged and still carries every
    // reviewer's verbatim output, which is exactly why the PR body no longer needs to.
    it('leaves the comment carrying the full override prose the dashboard dropped', () => {
        const rows = [
            new ChecklistCommentRow(
                'morpheus-envvars',
                CK_OVERRIDDEN,
                OVERRIDE_PROSE,
                true,
                ['**/*.ts'],
                ['**/*.ts'],
                ['src/a.ts'],
                4,
            ),
        ];
        const md = renderChecklistComment(rows, true);

        expect(md).toContain(OVERRIDE_PROSE);
        expect(md).toContain(
            '#### 🟠 morpheus-envvars — OVERRIDDEN — shipped with a stated justification',
        );
        expect(md).not.toContain('**Checklists:** '); // the dashboard row belongs to the PR body only
    });

    // The compact commit body is a separate artifact and keeps its per-checklist flags.
    it('carries matched checklists into the compact commit body unchanged', () => {
        const rows = [
            new ChecklistRow('hasura-reviewer', CK_PASS),
            new ChecklistRow('api-reviewer', CK_WARN, 'no rate limit'),
        ];
        const input = new DashboardInput(
            'My PR',
            computeGateResults([], []),
            countAddedDisables(''),
            true,
            'a',
            'b',
            'c',
            review(),
            rows,
        );
        const body = renderCommitBody(input, '');
        expect(body).toContain('Checklist — hasura-reviewer: 🟢 passed');
        expect(body).toContain('Checklist — api-reviewer: 🟡 passed with concerns');
    });
});

/**
 * OPTIONAL checklists on the PR comment.
 *
 * The comment is the durable record of how a PR was reviewed, and the failure mode this feature could
 * introduce is entirely a REPORTING one: an optional review that was offered and declined has the same
 * "no verdict" state as a review that was never relevant, and rendering the two identically would let a PR
 * that skipped every optional review read as fully covered.
 */
describe('renderChecklistComment — optional checklists', () => {
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
