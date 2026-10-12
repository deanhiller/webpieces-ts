import { describe, it, expect } from 'vitest';
import { VisibleTransitiveReduction } from '../visible-transitive-reduction';
import { transitiveReduction } from '../transitive-reduction';
import { sortGraphTopologically } from '../graph-sorter';
import { GraphVisualizer } from '../graph-visualizer';

const reducer = new VisibleTransitiveReduction();
const viz = new GraphVisualizer(
    (): string => '',
    (): string => '',
);

describe('VisibleTransitiveReduction (#1215)', () => {
    it('keeps A→C when the only longer path A→B→C runs through a hidden B', () => {
        const full = { a: ['b', 'c'], b: ['c'], c: [] };
        expect(reducer.reduce(full, new Set(['b']))).toEqual({ a: ['b', 'c'], b: ['c'], c: [] });
    });

    it('DRAWS A→C when B is hidden — the edge the rendered graph used to lose', () => {
        const full = { a: ['b', 'c'], b: ['c'], c: [] };
        const graph = sortGraphTopologically(reducer.reduce(full, new Set(['b'])));
        graph['b'].drawOnGraph = false;
        const dot = viz.generateDot(graph);
        expect(dot).toContain('"a" -> "c"');
        expect(dot).not.toContain('"b"');
    });

    it('the old full-graph reduction is what orphaned C (regression proof)', () => {
        const full = { a: ['b', 'c'], b: ['c'], c: [] };
        const graph = sortGraphTopologically(transitiveReduction(full));
        graph['b'].drawOnGraph = false;
        expect(viz.generateDot(graph)).not.toContain('"a" -> "c"');
    });

    it('still drops A→C when a VISIBLE path A→D→C exists beside the hidden one', () => {
        const full = { a: ['b', 'c', 'd'], b: ['c'], d: ['c'], c: [] };
        expect(reducer.reduce(full, new Set(['b']))).toEqual({ a: ['b', 'd'], b: ['c'], c: [], d: ['c'] });
    });

    it('changes nothing when no project is hidden', () => {
        const full = { a: ['b', 'c'], b: ['c'], c: [] };
        expect(reducer.reduce(full, new Set())).toEqual(transitiveReduction(full));
    });

    it('keeps the hidden project and its edges in the data view, and levels unchanged', () => {
        const full = {
            'rules-a': ['tooling-testkit', 'rules-sdk'],
            'rules-b': ['tooling-testkit', 'rules-sdk'],
            'tooling-testkit': ['rules-sdk'],
            'rules-sdk': [],
        };
        const reduced = reducer.reduce(full, new Set(['tooling-testkit']));
        expect(reduced).toEqual({
            'rules-a': ['rules-sdk', 'tooling-testkit'],
            'rules-b': ['rules-sdk', 'tooling-testkit'],
            'tooling-testkit': ['rules-sdk'],
            'rules-sdk': [],
        });
        const levels = (graph: Record<string, string[]>): Record<string, number> => {
            const sorted = sortGraphTopologically(graph);
            const result: Record<string, number> = {};
            for (const name of Object.keys(sorted)) result[name] = sorted[name].level;
            return result;
        };
        expect(levels(reduced)).toEqual(levels(transitiveReduction(full)));
    });
});
