import { describe, it, expect } from 'vitest';
import { GateDefinition, ReviewJson } from '@webpieces/rules-config';
import {
    Dashboard, DashboardInput, GateResult, DisableCounts, ChecklistRow, ChecklistCommentRow,
    CHECKLIST_COMMENT_MARKER,
} from './dashboard';
import { CK_PASS, CK_WARN, CK_OVERRIDDEN } from '@webpieces/rules-config';

const dash = new Dashboard();
const computeGateResults = (g: GateDefinition[], f: string[]): GateResult[] => dash.computeGateResults(g, f);
const countAddedDisables = (p: string): DisableCounts => dash.countAddedDisables(p);
const renderDashboard = (i: DashboardInput): string => dash.renderDashboard(i);
const renderCommitBody = (i: DashboardInput, url: string): string => dash.renderCommitBody(i, url);

function review(overrides: Partial<ReviewJson> = {}): ReviewJson {
    const base = new ReviewJson('A short title', 20, 'green', '🟢', 'A short summary.', [], [], []);
    return Object.assign(base, overrides);
}

const renderChecklistComment = (rows: ChecklistCommentRow[], verified: boolean, based = true): string =>
    dash.renderChecklistComment(rows, verified, based);

// The four files every fixture roster was matched against, so "x of 4" is always honest.
const FOUR_FILES = ['db/003.sql', 'src/a.ts', 'src/b.ts', 'README.md'];

// A reviewer that RAN because one of its two configured globs hit one of the 4 changed files.
function ranRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent, status, detail, true, ['db/**', '**/*.sql'], ['**/*.sql'], ['db/003.sql'], FOUR_FILES.length);
}

// A checklist that WAS evaluated and did not apply — its globs hit none of the 4 changed files.
function skippedRow(subagent: string): ChecklistCommentRow {
    return new ChecklistCommentRow(
        subagent, '', '', false, ['apps/web/**', '**/*.tsx'], [], [], FOUR_FILES.length);
}

// A PATTERNLESS checklist: always runs, whole diff in scope. Note it also has NO fired patterns — the same
// empty list a skipped checklist has, which is why the renderer must key off the configured list instead.
function alwaysRow(subagent: string, status: string, detail = ''): ChecklistCommentRow {
    return new ChecklistCommentRow(subagent, status, detail, true, [], [], FOUR_FILES, FOUR_FILES.length);
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
        expect(md).toContain('- [ ] ⚪ **a11y-reviewer** — skipped, not applicable to this diff (expected ✅)');
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
        expect(md).toContain('ALWAYS RUNS (no patterns) — whole diff in scope, 4 changed file(s)');
        expect(md).not.toContain('matched 0 of');
    });

    it('refuses to report an unresolvable diff base as an all-clear', () => {
        const md = renderChecklistComment([skippedRow('a11y-reviewer'), skippedRow('i18n-reviewer')], true, false);
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
        expect(md).toContain('#### 🟠 secrets-reviewer — OVERRIDDEN — shipped with a stated justification');
        expect(md).toContain('#### 🟡 api-reviewer — passed with concerns');
        expect(md).toContain('#### 🟢 db-reviewer — passed');
        expect(md).toContain('adds a route with no rate limit');
        // Overridden → warned → passed: a reader meets what needs attention before the wall of green.
        const sections = md.slice(md.indexOf('### Reviews that ran'));
        expect(sections.indexOf('secrets-reviewer')).toBeLessThan(sections.indexOf('api-reviewer'));
        expect(sections.indexOf('api-reviewer')).toBeLessThan(sections.indexOf('db-reviewer'));
    });

    it('gives NO section (and makes no provenance claim) when nothing had to run', () => {
        const md = renderChecklistComment([skippedRow('a11y-reviewer'), skippedRow('i18n-reviewer')], true);
        expect(md).toContain('— 2 defined · 0 ran · 2 skipped ✅');
        expect(md).toContain('No reviewer had to run on this diff');
        expect(md).not.toContain('### Reviews that ran');
        expect(md).not.toContain('verified from the Claude Code harness');
    });

    it('reflects provenance: verified vs unverified', () => {
        const rows = [ranRow('db-reviewer', CK_PASS, 'ok')];
        expect(renderChecklistComment(rows, true)).toContain('verified from the Claude Code harness');
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
        expect(md).toContain('tiny note');           // short body untouched
        expect(md).toContain('#### 🟢 huge-reviewer — passed');
        expect(md).toContain('truncated to fit');     // long body was cut
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
            'My PR', gates, disables, true, 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc',
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
            'My PR', gates, countAddedDisables(''), true, 'a', 'b', 'c',
            review({ riskScore: 80, riskLevel: 'red', riskEmoji: '🔴', violations: ['boundary crossed', 'naming'] }),
        );
        const md = renderDashboard(input);

        expect(md).toContain('**DB Schema Changed:** 🔴 Yes (1 file(s))');
        expect(md).toContain('**Risk Level:** 🔴 **red**');
        expect(md).toContain('**Pattern Violations:** 🟡 Yes (2 violation(s))');
    });
});

describe('renderCommitBody', () => {
    it('always includes the risk score, omits green rows, and appends the PR link', () => {
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c',
            review({ riskScore: 20, riskLevel: 'green', riskEmoji: '🟢', summary: 'One thing. Two thing. Three thing.' }),
        );
        const body = renderCommitBody(input, 'https://github.com/o/r/pull/42');

        expect(body).toContain('Risk: ');
        expect(body).toContain('20/100 🟢 (green)');
        expect(body).toContain('Flags: 🟢 all green');
        expect(body).toContain('One thing. Two thing. Three thing.');
        expect(body).toContain('PR: https://github.com/o/r/pull/42');
    });

    it('lists every non-green flag (build, gates, violations, disables)', () => {
        const gates = computeGateResults([new GateDefinition('API Changed', ['**/*Api.ts'], 'yellow')], ['src/FooApi.ts']);
        const disables = countAddedDisables(['+++ b/a.ts', '+// webpieces-disable no-any-unknown -- x', '+// eslint-disable-next-line'].join('\n'));
        const input = new DashboardInput(
            'My PR', gates, disables, false, 'a', 'b', 'c',
            review({ riskScore: 80, riskLevel: 'red', riskEmoji: '🔴', violations: ['boundary'] }),
        );
        const body = renderCommitBody(input, '');

        expect(body).toContain('Flags (non-green):');
        expect(body).toContain('- Build (nx affected): 🔴 Failed');
        expect(body).toContain('- Pattern Violations: 🟡 1 violation(s)');
        expect(body).toContain('- API Changed: 🟡 1 file(s)');
        expect(body).toContain('- Webpieces Disables Added: 🟡 1 line(s) — no-any-unknown');
        expect(body).toContain('- ESLint Disables Added: 🟡 1 line(s)');
        expect(body).not.toContain('PR: ');
    });

    it('caps the summary at 4 sentences', () => {
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c',
            review({ summary: 'S1. S2. S3. S4. S5. S6.' }),
        );
        const body = renderCommitBody(input, '');

        expect(body).toContain('S1. S2. S3. S4.');
        expect(body).not.toContain('S5.');
    });

    it('does not drop text or split on interior dots in filenames/paths/versions', () => {
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c',
            review({ summary: 'Edits dependencies.json and runtime-graph.ts under src/lib. Bumps to 0.4.447 cleanly.' }),
        );
        const body = renderCommitBody(input, '');

        // Both real sentences survive intact — the dotted tokens are NOT treated as sentence breaks and
        // no prose is silently discarded.
        expect(body).toContain('Edits dependencies.json and runtime-graph.ts under src/lib.');
        expect(body).toContain('Bumps to 0.4.447 cleanly.');
    });
});

describe('renderDashboard checklists', () => {
    it('renders NO checklist row when none triggered (non-adopting repos see no change)', () => {
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c', review(),
        );
        expect(renderDashboard(input)).not.toContain('Checklist —');
    });

    it('renders one row per matched checklist with its resolved verdict', () => {
        const rows = [
            new ChecklistRow('migrations-reviewer', CK_PASS),
            new ChecklistRow('hasura-reviewer', CK_OVERRIDDEN, 'behind a flag; ONE-2210'),
        ];
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c', review(), rows,
        );
        const md = renderDashboard(input);
        expect(md).toContain('**Checklist — migrations-reviewer:** 🟢 passed');
        expect(md).toContain('**Checklist — hasura-reviewer:** 🟠 OVERRIDDEN — override: behind a flag; ONE-2210');
    });

    it('renders a yellow verdict as passed-with-concerns, never as a plain pass', () => {
        const rows = [new ChecklistRow('api-reviewer', CK_WARN, 'no rate limit on the new route')];
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c', review(), rows,
        );
        expect(renderDashboard(input)).toContain('**Checklist — api-reviewer:** 🟡 passed with concerns');
        expect(renderCommitBody(input, '')).toContain('Checklist — api-reviewer: 🟡 passed with concerns');
    });

    it('carries matched checklists into the compact commit body', () => {
        const rows = [new ChecklistRow('hasura-reviewer', CK_PASS)];
        const input = new DashboardInput(
            'My PR', computeGateResults([], []), countAddedDisables(''), true, 'a', 'b', 'c', review(), rows,
        );
        expect(renderCommitBody(input, '')).toContain('Checklist — hasura-reviewer: 🟢 passed');
    });
});
