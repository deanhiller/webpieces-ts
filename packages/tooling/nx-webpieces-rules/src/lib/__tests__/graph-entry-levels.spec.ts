/**
 * Servers, clients and apps always sit in the top row (#1179) — and every dependency still sits
 * strictly below its dependent.
 */
import { describe, it, expect } from 'vitest';
import type { EnhancedGraph, GraphEntry } from '../graph-sorter';
import { EntryPointLevels } from '../graph-entry-levels';
import { APP_ROLES } from '../graph-metadata';
import { ProjectCycleDetector } from '../graph-cycles';

const promote = (graph: EnhancedGraph): EnhancedGraph => {
    new EntryPointLevels(APP_ROLES).promote(graph);
    return graph;
};

const levels = (graph: EnhancedGraph): Record<string, number> =>
    Object.fromEntries(
        Object.entries(graph).map(([name, entry]: [string, GraphEntry]): [string, number] => [name, entry.level]),
    );

/** Throws when some dependency does not sit strictly below its dependent. */
const assertDescend = (graph: EnhancedGraph): void => {
    const cycles = new ProjectCycleDetector();
    const adjacency: Record<string, string[]> = {};
    for (const [name, entry] of Object.entries(graph)) adjacency[name] = entry.dependsOn;
    cycles.assertLevelsDescend(adjacency, cycles.levelsOf(graph), 'spec');
};

describe('EntryPointLevels.promote', () => {
    it('a client at L6 and a server at L7 both end at L7', () => {
        const graph: EnhancedGraph = {
            lib: { level: 6, dependsOn: [], role: 'lib' },
            client: { level: 6, dependsOn: [], role: 'client' },
            server: { level: 7, dependsOn: ['lib'], role: 'server' },
        };
        expect(levels(promote(graph))).toEqual({ lib: 6, client: 7, server: 7 });
        assertDescend(graph);
    });

    it('a library nothing depends on, at the old top, pushes the entry points one row higher', () => {
        const graph: EnhancedGraph = {
            base: { level: 0, dependsOn: [], role: 'lib' },
            tall: { level: 3, dependsOn: ['base'], role: 'lib' },
            server: { level: 3, dependsOn: ['base'], role: 'server' },
            app: { level: 1, dependsOn: ['base'], role: 'app' },
        };
        expect(levels(promote(graph))).toEqual({ base: 0, tall: 3, server: 4, app: 4 });
        assertDescend(graph);
    });

    it('a bundle stays above the apps it aggregates, and is not counted toward the top', () => {
        const graph: EnhancedGraph = {
            lib: { level: 0, dependsOn: [], role: 'lib' },
            app1: { level: 1, dependsOn: ['lib'], role: 'app' },
            app2: { level: 2, dependsOn: ['lib'], role: 'app' },
            bundle: { level: 3, dependsOn: ['app1', 'app2'], role: 'bundle' },
        };
        expect(levels(promote(graph))).toEqual({ lib: 0, app1: 2, app2: 2, bundle: 3 });
        assertDescend(graph);
    });

    it('a server orchestrator sits above the servers it boots, so levels still descend', () => {
        const graph: EnhancedGraph = {
            lib: { level: 0, dependsOn: [], role: 'lib' },
            worker: { level: 1, dependsOn: ['lib'], role: 'server' },
            harness: { level: 2, dependsOn: ['worker'], role: 'server' },
        };
        expect(levels(promote(graph))).toEqual({ lib: 0, worker: 2, harness: 3 });
        assertDescend(graph);
    });

    it('a graph with no entry point is left exactly as it was', () => {
        const graph: EnhancedGraph = {
            a: { level: 0, dependsOn: [], role: 'lib' },
            b: { level: 1, dependsOn: ['a'], role: 'designed-lib' },
        };
        expect(levels(promote(graph))).toEqual({ a: 0, b: 1 });
    });

    it('no library ever shares the top row', () => {
        const graph: EnhancedGraph = {
            a: { level: 0, dependsOn: [], role: 'lib' },
            b: { level: 1, dependsOn: ['a'], role: 'api-lib' },
            c: { level: 2, dependsOn: ['b'], role: 'designed-lib' },
            client: { level: 1, dependsOn: ['a'], role: 'client' },
        };
        promote(graph);
        const top = Math.max(...Object.values(graph).map((entry: GraphEntry): number => entry.level));
        const onTop = Object.keys(graph).filter((name: string): boolean => graph[name].level === top);
        expect(onTop).toEqual(['client']);
        assertDescend(graph);
    });
});
