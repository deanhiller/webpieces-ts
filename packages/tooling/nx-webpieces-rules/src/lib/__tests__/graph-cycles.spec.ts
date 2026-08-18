/**
 * The architecture graph is a BUILD graph: it must be a DAG, every cycle must be named at once
 * (not one per run), and the chain must be printed in project KEYS so it can be acted on.
 */

import { describe, it, expect } from 'vitest';
import {
    CircularProjectDependencyError,
    LevelViolationError,
    ProjectAdjacency,
    ProjectCycleDetector,
} from '../graph-cycles';
import type { EnhancedGraph } from '../graph-sorter';
import { toError } from '../../toError';

const detector = new ProjectCycleDetector();

/** The chains the detector found, as `a -> b -> a` strings. */
const chains = (graph: ProjectAdjacency): string[] =>
    detector.find(graph).map((cycle): string => cycle.describe());

/** Run `act` and return whatever it threw, so a test can assert on the type AND the text. */
const thrownBy = (act: () => void): Error => {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        act();
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
    throw new Error('expected the call to throw, but it returned normally');
};

describe('ProjectCycleDetector.find', () => {
    it('finds a simple 2-node cycle', () => {
        expect(chains({ a: ['b'], b: ['a'] })).toEqual(['a -> b -> a']);
    });

    it('prints the FULL path of a 3-node cycle, not just the pair that closes it', () => {
        expect(chains({ a: ['b'], b: ['c'], c: ['a'] })).toEqual(['a -> b -> c -> a']);
    });

    it('treats a self-loop as the degenerate cycle', () => {
        expect(chains({ a: ['a'], b: [] })).toEqual(['a -> a']);
    });

    it('reports EVERY disjoint cycle, not only the first', () => {
        expect(chains({
            a: ['b'], b: ['a'],
            x: ['y'], y: ['z'], z: ['x'],
            leaf: [],
        })).toEqual(['a -> b -> a', 'x -> y -> z -> x']);
    });

    it('finds nothing in an acyclic graph', () => {
        expect(chains({ server: ['api', 'util'], api: ['util'], util: [] })).toEqual([]);
    });

    /**
     * The reason detection runs on project KEYS: `@mealco-internal/public-api` (L0 contract lib) and
     * `public-api` (L6 server) are two distinct projects that strip to the same short name. Detecting
     * on short names would fuse them and report their perfectly legal L6 → L0 edge as `public-api ->
     * public-api`, a cycle that does not exist.
     */
    it('does not invent a cycle for two projects whose names differ only by scope', () => {
        expect(chains({
            'public-api': ['@mealco-internal/public-api'],
            '@mealco-internal/public-api': [],
        })).toEqual([]);
    });

    it('tolerates a dependency on a project that is not a key of the graph', () => {
        expect(chains({ a: ['not-in-graph'] })).toEqual([]);
    });
});

describe('ProjectCycleDetector.assertAcyclic', () => {
    it('passes an acyclic graph silently', () => {
        expect((): void => detector.assertAcyclic({ a: ['b'], b: [] }, 'src')).not.toThrow();
    });

    it('fails loudly, naming the source, the count and every chain', () => {
        const error = thrownBy((): void =>
            detector.assertAcyclic({ a: ['b'], b: ['a'], x: ['x'] }, 'architecture/dependencies.json'));
        expect(error).toBeInstanceOf(CircularProjectDependencyError);
        expect(error.message).toContain('architecture/dependencies.json');
        expect(error.message).toContain('contains 2 cycles');
        expect(error.message).toContain('a -> b -> a');
        expect(error.message).toContain('x -> x');
        expect(error.message).toContain('break each chain');
    });
});

describe('ProjectCycleDetector level monotonicity', () => {
    const GRAPH: EnhancedGraph = {
        server: { level: 2, dependsOn: ['api'] },
        api: { level: 1, dependsOn: ['util'] },
        util: { level: 0, dependsOn: [] },
    };
    const adjacency: ProjectAdjacency = { server: ['api'], api: ['util'], util: [] };

    it('accepts a graph whose every dependency sits strictly lower', () => {
        expect(detector.findLevelViolations(adjacency, detector.levelsOf(GRAPH))).toEqual([]);
    });

    it('names an edge that does not descend, with both levels', () => {
        const levels = detector.levelsOf({ ...GRAPH, api: { level: 2, dependsOn: ['util'] } });
        const error = thrownBy((): void =>
            detector.assertLevelsDescend(adjacency, levels, 'the freshly sorted graph'));
        expect(error).toBeInstanceOf(LevelViolationError);
        expect(error.message).toContain('server (L2) -> api (L2)');
    });

    it('ignores an edge to a project the levels do not cover', () => {
        expect(detector.findLevelViolations({ a: ['ghost'] }, new Map([['a', 3]]))).toEqual([]);
    });
});
