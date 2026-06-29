import { describe, it, expect } from 'vitest';
import { GateDefinition } from '@webpieces/rules-config';
import {
    computeGateResults,
    countAddedDisables,
    renderDashboard,
    DashboardInput,
} from './dashboard';

describe('computeGateResults', () => {
    it('matches glob patterns and reports matched files', () => {
        const gates = [
            new GateDefinition('API Changed', ['libraries/apis/**', '**/*Api.ts'], 'warn'),
            new GateDefinition('Schema', ['db/schema.sql'], 'block'),
        ];
        const changed = ['libraries/apis/Foo.ts', 'src/x/BarApi.ts', 'src/util.ts'];
        const results = computeGateResults(gates, changed);

        expect(results[0].matchedFiles).toEqual(['libraries/apis/Foo.ts', 'src/x/BarApi.ts']);
        expect(results[1].matchedFiles).toEqual([]);
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
    it('renders green/yellow gates and build status', () => {
        const gates = computeGateResults(
            [new GateDefinition('API Changed', ['**/*Api.ts'], 'warn')],
            ['src/FooApi.ts'],
        );
        const disables = countAddedDisables('');
        const input = new DashboardInput('My PR', gates, disables, true, 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', '');
        const md = renderDashboard(input);

        expect(md).toContain('🚦 PR Gate Dashboard');
        expect(md).toContain('**Build (nx affected):** 🟢 Passed');
        expect(md).toContain('**API Changed:** 🟡 Yes (1 file(s))');
        expect(md).toContain('Fork point (A): `aaaaaaaaaaaa`');
    });
});
