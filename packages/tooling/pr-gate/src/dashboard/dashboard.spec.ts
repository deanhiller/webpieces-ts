import { describe, it, expect } from 'vitest';
import { GateDefinition, ReviewJson } from '@webpieces/rules-config';
import {
    Dashboard,
    DashboardInput,
    GateResult,
    DisableCounts,
    ChecklistRow,
} from './dashboard';
import { CK_PASS, CK_WARN, CK_OVERRIDDEN, CK_FAIL, CK_MISSING } from '@webpieces/rules-config';
import { ChecklistCommentRenderer } from './checklist-comment-renderer';
import { ChecklistCommentRow } from './checklist-comment-row';

const dash = new Dashboard();
const computeGateResults = (g: GateDefinition[], f: string[]): GateResult[] =>
    dash.computeGateResults(g, f);
const countAddedDisables = (p: string): DisableCounts => dash.countAddedDisables(p);
const renderDetailComment = (i: DashboardInput): string => dash.renderDetailComment(i);
const renderPrBody = (i: DashboardInput, url: string): string => dash.renderPrBody(i, url);

function review(overrides: Partial<ReviewJson> = {}): ReviewJson {
    const base = new ReviewJson('A short title', 20, 'green', '🟢', 'A short summary.', [], [], []);
    return Object.assign(base, overrides);
}

// The 2nd comment's renderer, used here only by the tests that contrast what the DASHBOARD row drops
// against what the comment keeps. Its own behaviour is covered in checklist-comment-renderer.spec.ts.
const checklistRenderer = new ChecklistCommentRenderer();
const renderChecklistComment = (
    rows: ChecklistCommentRow[],
    verified: boolean,
    based = true,
): string => checklistRenderer.render(rows, verified, based);

// A minimal all-green input, so a test about ONE property of the PR body does not restate ten
// positional constructor arguments to get at it. `buildCommand` is a parameter rather than a fixed
// string because DashboardInput deliberately requires it — the no-build-command case is a real state a
// test has to be able to ASK for, not one it falls into by leaving an argument off.
function baseInput(
    reviewOverrides: Partial<ReviewJson> = {},
    buildCommand = 'pnpm nx affected --target=ci',
): DashboardInput {
    return new DashboardInput(
        'My PR',
        computeGateResults([], []),
        countAddedDisables(''),
        true,
        'aaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbb',
        'cccccccccccccccc',
        review(reviewOverrides),
        [],
        buildCommand,
    );
}

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

describe('renderDetailComment', () => {
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
        [],
        'pnpm nx affected --target=ci',
    );
        const md = renderDetailComment(input);

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
        [],
        'pnpm nx affected --target=ci',
    );
        const md = renderDetailComment(input);

        expect(md).toContain('**DB Schema Changed:** 🔴 Yes (1 file(s))');
        expect(md).toContain('**Risk Level:** 🔴 **red**');
        expect(md).toContain('**Pattern Violations:** 🟡 Yes (2 violation(s))');
    });

    /**
     * The footer names the tooling by REPO URL, so a reader who lands on a generated comment in any
     * consumer repo can find what produced it. It no longer claims "build ran via nx affected" — that was
     * hard-coded and wrong wherever buildCommand is not nx, and the honest version of that claim now
     * lives in the PR body, naming the real command.
     */
    it('footers with the webpieces repo URL, not the old hard-coded nx claim', () => {
        const md = renderDetailComment(baseInput());
        expect(md).toContain('Generated by https://github.com/deanhiller/webpieces-ts  wp-finish-upsert-pr');
        expect(md).not.toContain('not self-attested');
    });

    /**
     * This comment is where the long form belongs — the whole summary, not the 4-sentence abstract the PR
     * body carries. A reader following the pointer must get MORE than they already saw.
     */
    it('carries the FULL summary, where the PR body carries only its first sentences', () => {
        const long = 'S1. S2. S3. S4. S5. S6.';
        const input = baseInput({ summary: long });
        expect(renderDetailComment(input)).toContain(long);
        expect(renderPrBody(input, 'https://github.com/o/r/pull/42')).not.toContain('S5.');
    });
});

describe('renderPrBody', () => {
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
        [],
        'pnpm nx affected --target=ci',
    );
        const body = renderPrBody(input, 'https://github.com/o/r/pull/42');

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

    /**
     * The link is BARE — no caption. It used to read `<url> (for git log)`, a label aimed at a reader on
     * the GitHub page (where the link is redundant, being the page they are on) to stop them deleting it.
     * But this same string IS the squash-commit body, so that caption landed in `main`'s history verbatim
     * on every single commit, forever, to serve one transient reading. In `git log` a bare URL is
     * self-evidently the route back and explains itself. Asserting the ABSENCE of the old caption, not
     * just the presence of the URL — the whole point is that the permanent surface stays clean.
     */
    it('leads with a bare URL and no caption, so git log carries no page-reader label', () => {
        const body = renderPrBody(baseInput(), 'https://github.com/o/r/pull/42');
        expect(body.startsWith('https://github.com/o/r/pull/42\n')).toBe(true);
        expect(body).not.toContain('(for git log)');
    });

    /**
     * The pointer to the comments, on EVERY body including the all-green one. Without it the compact body
     * reads as the complete record, and a reader of main's history never learns that the green rows, the
     * full summary and each reviewer's output are one click away.
     */
    it('always ends the flag list with the pointer to the comments — green case included', () => {
        const green = renderPrBody(baseInput(), 'https://github.com/o/r/pull/42');
        expect(green).toContain('Flags: 🟢 all green');
        expect(green).toContain('- (Full dashboard in 1st comment, reviewer checklist in 2nd — kept out of git log)');

        const red = renderPrBody(baseInput({ riskScore: 80, riskLevel: 'red', riskEmoji: '🔴', violations: ['boundary'] }), '');
        expect(red).toContain('Non-green Flags (full list in first comment to avoid large git logs)');
        expect(red).toContain('- (Full dashboard in 1st comment, reviewer checklist in 2nd — kept out of git log)');
    });

    /**
     * The footer NAMES the build command from config. It used to hard-code "build ran via nx affected",
     * which was simply false on any repo whose buildCommand is not nx — and this line lands in permanent
     * history, so a false claim there is permanent too.
     */
    it('names the configured build command in the footer, with no markdown', () => {
        const body = renderPrBody(baseInput({}, 'pnpm turbo run ci'), 'https://github.com/o/r/pull/42');
        expect(body).toContain('Generated by webpieces-ts wp-finish-upsert-pr (pnpm turbo run ci run locally)');
        // `git log` renders in a terminal, where a backtick is literal punctuation, not formatting.
        expect(body).not.toContain('`');
        expect(body).not.toContain('nx affected — not self-attested');
    });

    // A repo with genuinely no build command still gets a coherent footer — but only because someone
    // passed '' on purpose. DashboardInput requires the field precisely so this cannot happen by omission.
    it('omits the parenthetical entirely when buildCommand is deliberately empty', () => {
        const body = renderPrBody(baseInput({}, ''), 'https://github.com/o/r/pull/42');
        expect(body).toContain('Generated by webpieces-ts wp-finish-upsert-pr');
        expect(body).not.toContain('run locally');
    });

    /**
     * Everything the OLD PR description carried that a squash commit must not: the risk TABLE, the
     * per-row green statuses, the 3-point hash points. Those moved to the 1st comment. This is the
     * pollution guard — the whole reason the two surfaces were swapped.
     */
    it('carries none of the long-form dashboard that used to pollute git log', () => {
        const body = renderPrBody(baseInput(), 'https://github.com/o/r/pull/42');
        expect(body).not.toContain('## 🚦 PR Gate Dashboard');
        expect(body).not.toContain('3-Point Hash Points');
        expect(body).not.toContain('**Risk Score:**');
        expect(body).not.toContain('🟢 No');
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
        [],
        'pnpm nx affected --target=ci',
    );
        const body = renderPrBody(input, '');

        expect(body).toContain('Non-green Flags (full list in first comment to avoid large git logs)');
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
        [],
        'pnpm nx affected --target=ci',
    );
        const body = renderPrBody(input, '');

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
        [],
        'pnpm nx affected --target=ci',
    );
        const body = renderPrBody(input, '');

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
    'pnpm nx affected --target=ci',
);
    return renderDetailComment(input);
}

describe('renderDetailComment checklists — ONE rolled-up row', () => {
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
        [],
        'pnpm nx affected --target=ci',
    );
        const md = renderDetailComment(input);
        expect(md).toContain(
            '**Checklists:** ⚪ 0 ran — no review checklist matched this PR · see the checklist comment',
        );
        expect(md).not.toContain('**Checklists:** 🟢');
        expect(md).not.toContain('Checklist —'); // and no per-checklist row survives anywhere
    });

    // The bug this row replaced: six checklists meant six rows, each repeating the SAME override paragraph.
    it('collapses six overridden checklists into ONE orange row with a count and NO override prose', () => {
        const ids = [
            'checklist-envvars',
            'checklist-frontend',
            'checklist-db',
            'checklist-api',
            'checklist-infra',
            'checklist-a11y',
        ];
        const md = dashboardWith(
            ids.map(
                (id: string): ChecklistRow => new ChecklistRow(id, CK_OVERRIDDEN, OVERRIDE_PROSE),
            ),
        );

        expect(md).toContain(
            '**Checklists:** 🟠 6 ran — 6 overridden (checklist-envvars, checklist-frontend, ' +
                'checklist-db, checklist-api +2 more) · per-checklist detail in the checklist comment',
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

describe('renderDetailComment checklists — the detail still lives in the comment', () => {
    // The roll-up row is a SUMMARY, not a replacement: the comment is unchanged and still carries every
    // reviewer's verbatim output, which is exactly why the PR body no longer needs to.
    it('leaves the comment carrying the full override prose the dashboard dropped', () => {
        const rows = [
            new ChecklistCommentRow(
                'checklist-envvars',
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
            '#### 🟠 checklist-envvars — OVERRIDDEN — shipped with a stated justification',
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
        'pnpm nx affected --target=ci',
    );
        const body = renderPrBody(input, '');
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
