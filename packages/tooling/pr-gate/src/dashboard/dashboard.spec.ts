import { describe, it, expect } from 'vitest';
import { GateDefinition, ReviewJson } from '@webpieces/rules-config';
import { Dashboard, DashboardInput, GateResult, DisableCounts } from './dashboard';

const dash = new Dashboard();
const computeGateResults = (g: GateDefinition[], f: string[]): GateResult[] => dash.computeGateResults(g, f);
const countAddedDisables = (p: string): DisableCounts => dash.countAddedDisables(p);
const renderDashboard = (i: DashboardInput): string => dash.renderDashboard(i);
const renderCommitBody = (i: DashboardInput, url: string): string => dash.renderCommitBody(i, url);

function review(overrides: Partial<ReviewJson> = {}): ReviewJson {
    const base = new ReviewJson('A short title', 20, 'green', '🟢', 'A short summary.', [], [], []);
    return Object.assign(base, overrides);
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
});
