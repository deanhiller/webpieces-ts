/**
 * The page side of #1264, run from the shipped client source in a bare VM (no browser): which shade
 * each affected box gets, what its "why" panel says, and the split count line. An implicitly touched
 * project is shaded and explained as IMPLICIT — never as a dependent.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { ImpactKind, ImpactSidecarData } from '../graph-impact';
import { BRANCH_LABEL, NO_EDGES, WIRING_INPUT, impactScan } from './graph-browser-fixture';

interface ReasonShape {
    kind: string;
    project: string;
}
interface ModeStateShape {
    status(id: string): string;
    affected(): string[];
    reason(id: string): ReasonShape | null;
}
interface WhyShape {
    title(reason: ReasonShape): string;
    lines(reason: ReasonShape): string[];
    counts(impact: ImpactSidecarData['scans'][number]): string;
}
interface ClientApi {
    modes: ModeStateShape;
    why: WhyShape;
}

const SOURCE = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'graph-mode-state.client.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

/** The client classes over one sidecar, with the browser globals they read stubbed. */
function client(data: ImpactSidecarData): ClientApi {
    const sidecar = JSON.parse(JSON.stringify(data)) as ImpactSidecarData;
    const context = {
        window: { __WP_IMPACT__: sidecar },
        location: { hash: '' },
        localStorage: { getItem: (): null => null, setItem: (): void => undefined },
        history: { replaceState: (): void => undefined },
        document: { body: { dataset: {} } },
    };
    return vm.runInNewContext(
        `${SOURCE}\n({ modes: new WpModeState(false, 'architecture', ''), why: new WpImpactWhy() })`,
        context,
    ) as ClientApi;
}

const SCAN = impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['svc-a'], ['gateway'], ['core'], 1, [], [], '', ['public-api']);

describe('Impact "why" on the page (#1264)', () => {
    it('shades an implicitly touched box as implicit, a dependent as dependent, and counts them apart', () => {
        const api = client(new ImpactSidecarData([SCAN], ImpactKind.BRANCH, NO_EDGES));
        expect(api.modes.status('svc-a')).toBe('touched');
        expect(api.modes.status('gateway')).toBe('dependent');
        expect(api.modes.status('public-api')).toBe('implicit');
        expect(api.modes.status('core')).toBe('buildInput');
        expect(api.modes.status('elsewhere')).toBe('untouched');
        expect([...api.modes.affected()].sort()).toEqual(['gateway', 'public-api', 'svc-a']);
        expect(api.why.counts(SCAN)).toBe('1 changed · 1 dependents · 1 implicitly touched (wiring-check inputs) · 1 dependencies');
    });

    it('explains an implicit touch by its target, glob and file — and says it uses no changed project', () => {
        const api = client(new ImpactSidecarData([SCAN], ImpactKind.BRANCH, NO_EDGES));
        const reason = api.modes.reason('public-api') as ReasonShape;
        expect(api.why.title(reason)).toBe('Implicitly touched: public-api');
        const lines = api.why.lines(reason);
        expect(lines[0]).toBe(`wiring-check input ${WIRING_INPUT} matched services/a/src/wiring.ts`);
        expect(lines.join(' ')).toContain('It uses no changed project');
        expect(lines.join(' ')).not.toContain('->');
    });

    it('explains a dependent by its edge path, and a changed project by the files it owns', () => {
        const api = client(new ImpactSidecarData([SCAN], ImpactKind.BRANCH, NO_EDGES));
        expect(api.why.lines(api.modes.reason('gateway') as ReasonShape)).toContain('gateway -> svc-a');
        expect(api.why.lines(api.modes.reason('svc-a') as ReasonShape)).toEqual(['It owns this changed file:', 'svc-a/src/index.ts']);
        expect(api.modes.reason('core')).toBeNull();
    });
});
