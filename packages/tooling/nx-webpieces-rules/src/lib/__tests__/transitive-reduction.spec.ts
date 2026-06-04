import { describe, it, expect } from 'vitest';
import { transitiveReduction } from '../transitive-reduction';

/**
 * Compute the transitive closure (reachable set) of every node in a graph.
 * Used to assert that reduction preserves reachability exactly — this IS the
 * "build order == reduced view" guarantee: same reachability ⇒ same valid
 * topological orderings.
 */
function closureOf(graph: Record<string, string[]>): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    function reach(node: string, acc: Set<string>): void {
        for (const child of graph[node] ?? []) {
            if (!acc.has(child)) {
                acc.add(child);
                reach(child, acc);
            }
        }
    }
    for (const node of Object.keys(graph)) {
        const acc = new Set<string>();
        reach(node, acc);
        result[node] = Array.from(acc).sort();
    }
    return result;
}

describe('transitiveReduction', () => {
    it('removes a redundant skip-level edge (A→C when A→B→C)', () => {
        const full = { a: ['b', 'c'], b: ['c'], c: [] };
        expect(transitiveReduction(full)).toEqual({ a: ['b'], b: ['c'], c: [] });
    });

    it('keeps edges that are not transitively reachable', () => {
        // a depends on b and c independently; neither reaches the other.
        const full = { a: ['b', 'c'], b: [], c: [] };
        expect(transitiveReduction(full)).toEqual({ a: ['b', 'c'], b: [], c: [] });
    });

    it('reduces a diamond to its minimal edges', () => {
        // a→b, a→c, b→d, c→d, plus redundant a→d
        const full = { a: ['b', 'c', 'd'], b: ['d'], c: ['d'], d: [] };
        expect(transitiveReduction(full)).toEqual({
            a: ['b', 'c'],
            b: ['d'],
            c: ['d'],
            d: [],
        });
    });

    it('collapses a long redundant chain (A→B,C,D when A→B→C→D)', () => {
        const full = { a: ['b', 'c', 'd'], b: ['c'], c: ['d'], d: [] };
        expect(transitiveReduction(full)).toEqual({
            a: ['b'],
            b: ['c'],
            c: ['d'],
            d: [],
        });
    });

    it('handles a leaf-only graph (no edges)', () => {
        const full = { a: [], b: [] };
        expect(transitiveReduction(full)).toEqual({ a: [], b: [] });
    });

    it('sorts the kept children deterministically', () => {
        const full = { a: ['c', 'b'], b: [], c: [] };
        expect(transitiveReduction(full).a).toEqual(['b', 'c']);
    });

    it('PROPERTY: reduction preserves reachability exactly (build order == view)', () => {
        const graphs: Record<string, string[]>[] = [
            { a: ['b', 'c'], b: ['c'], c: [] },
            { a: ['b', 'c', 'd'], b: ['d'], c: ['d'], d: [] },
            { a: ['b', 'c', 'd'], b: ['c'], c: ['d'], d: [] },
            // resembling this repo's shape
            {
                'http-server': ['http-routing', 'http-api', 'http-filters', 'core-util', 'core-context'],
                'http-routing': ['http-api', 'http-filters', 'core-context'],
                'http-filters': ['core-context'],
                'http-api': ['core-util'],
                'core-context': ['core-util'],
                'core-util': [],
            },
        ];
        for (const full of graphs) {
            const reduced = transitiveReduction(full);
            expect(closureOf(reduced)).toEqual(closureOf(full));
            // reduced is a subset of full (never adds edges)
            for (const node of Object.keys(full)) {
                for (const dep of reduced[node]) {
                    expect(full[node]).toContain(dep);
                }
            }
        }
    });
});
