/**
 * A cyclic RUNTIME graph is not allowed, period.
 *
 * `assignLevels` used to swallow the cycle and flatten EVERY service to level 0 — one bad edge
 * anywhere restratified the whole diagram into a legitimate-looking flat row, with the reason
 * discarded. It now THROWS, naming each `a -> b -> a` chain, because CD deploys in dependency order
 * and a cycle has no such order.
 *
 * The one escape is the `cutLegacyCycle:<targetService>` nx tag on the CALLING project: per-edge,
 * still drawn, and an admission of legacy debt rather than a claim the edge is harmless. A tag that
 * cuts nothing — a typo'd target, or one whose edge is already gone — fails the build, because a
 * silently-inert exemption is the worst outcome available here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { RuleFailError, Option } from '@webpieces/rules-config';
import { adjacencyFromEdges, assignLevels, runtimeAdjacency } from '../runtime-graph-levels';
import { deriveRuntimeGraph, deriveRuntimeGraphReport } from '../runtime-graph';
import { generateRuntimeDot, RuntimeVizOptions } from '../runtime-visualizer';
import { resolveCutLegacyCycles } from '../cut-legacy-cycle-resolver';
import { ProjectInfo } from '../project-info';
import { toError } from '../../toError';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeEdge, RuntimeGraph } from '../runtime-graph-model';

/**
 * The `RuleFailError` a cyclic graph produces. The ONE catch in this file: asserting on a thrown
 * value's STRUCTURE is the whole point of these tests, and `toThrow` can only match its message.
 */
function cycleFailure(adjacency: Record<string, string[]>): RuleFailError {
    // webpieces-disable no-unmanaged-exceptions -- a spec asserting on the structure of a thrown value must catch it
    try {
        assignLevels(adjacency);
    } catch (err: unknown) {
        const error = toError(err);
        return error as RuleFailError;
    }
    throw new Error('expected assignLevels to throw on a cyclic graph, but it returned levels');
}

/** One rpc-contract api-lib, and two servers wired however the test asks. */
function twoServers(aCalls: boolean, bCalls: boolean, cut?: string[]): EnhancedGraph {
    const graph: EnhancedGraph = {
        'shared-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        alpha: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            webpiecesRuntime: ['http-server'],
            apiRelations: {
                'shared-api': {
                    kind: 'both',
                    implements: [{ api: 'AlphaApi', type: 'rpc' }],
                    uses: aCalls ? [{ api: 'BetaApi', type: 'rpc' }] : [],
                },
            },
        },
        beta: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            webpiecesRuntime: ['http-server'],
            apiRelations: {
                'shared-api': {
                    kind: 'both',
                    implements: [{ api: 'BetaApi', type: 'rpc' }],
                    uses: bCalls ? [{ api: 'AlphaApi', type: 'rpc' }] : [],
                },
            },
        },
    };
    if (cut !== undefined) graph['alpha'].cutLegacyCycle = cut;
    return graph;
}

function edge(from: string, to: string, extra: Partial<RuntimeEdge> = {}): RuntimeEdge {
    return { from, to, via: ['SomeApi'], type: 'rpc', ...extra };
}

describe('assignLevels — a cycle THROWS instead of flattening the graph', () => {
    it('throws a RuleFailError naming the actual cycle path', () => {
        const failure = cycleFailure({ a: ['b'], b: ['a'], lonely: [] });
        expect(failure).toBeInstanceOf(RuleFailError);
        expect(failure.ruleName).toBe('runtime-architecture');
        expect(failure.aiMessage).toContain('a -> b -> a');
        expect(failure.aiMessage).toContain('CD deploys services in dependency order');
    });

    it('offers the honest cures first and the debt admission last', () => {
        const cures = cycleFailure({ a: ['b'], b: ['a'] }).fixOptions;
        expect(cures).toHaveLength(4);
        expect(cures[0].preferred).toBe(true);
        expect(cures[0].text).toContain('role:lib');
        expect(cures[1].text).toContain('@PubSub()');
        expect(cures[2].text).toContain('role:api-lib');
        expect(cures[3].text).toContain('cutLegacyCycle:');
        expect(cures[3].text).toContain('legacy debt');
        // Nothing but the LAST option may be the cut — the IOU is never presented as an equal.
        const earlier = cures
            .slice(0, 3)
            .filter((o: Option): boolean => o.text.includes('cutLegacyCycle'));
        expect(earlier).toEqual([]);
    });

    it('reports a self-loop, and every independent cycle in one run', () => {
        const failure = cycleFailure({ a: ['a'], x: ['y'], y: ['x'] });
        expect(failure.aiMessage).toContain('a -> a');
        expect(failure.aiMessage).toContain('x -> y -> x');
        expect(failure.aiMessage).toContain('2 cycles');
    });

    it('still levels an acyclic graph exactly as before', () => {
        expect(assignLevels({ top: ['mid'], mid: ['base'], base: [] })).toEqual({
            base: 0,
            mid: 1,
            top: 2,
        });
    });
});

describe('adjacencyFromEdges — the two excluded edge kinds', () => {
    it('excludes pubsub edges, exactly as before', () => {
        const adjacency = adjacencyFromEdges(
            ['worker', 'web'],
            [edge('web', 'worker', { type: 'pubsub', queue: 'EmailApi.send' })],
        );
        expect(adjacency).toEqual({ worker: [], web: [] });
    });

    it('excludes an edge stamped cutLegacyCycle, and keeps every other edge', () => {
        const adjacency = adjacencyFromEdges(
            ['a', 'b', 'c'],
            [edge('a', 'b', { cutLegacyCycle: true }), edge('a', 'c')],
        );
        expect(adjacency).toEqual({ a: ['c'], b: [], c: [] });
    });
});

describe('cutLegacyCycle: nx tag', () => {
    it('collects every target the project names, sorted', () => {
        const info = new ProjectInfo('alpha', 'apps/alpha', [
            'role:server',
            'cutLegacyCycle:server2',
            'cutLegacyCycle:beta',
        ]);
        expect(resolveCutLegacyCycles(info).targets).toEqual(['beta', 'server2']);
    });

    it('is absent by default', () => {
        const info = new ProjectInfo('alpha', 'apps/alpha', ['role:server']);
        expect(resolveCutLegacyCycles(info).targets).toEqual([]);
    });

    it('rejects an empty target', () => {
        const info = new ProjectInfo('alpha', 'apps/alpha', ['cutLegacyCycle:']);
        expect(resolveCutLegacyCycles(info).problem).toContain('must name the target');
    });

    it('rejects the same target declared twice', () => {
        const info = new ProjectInfo('alpha', 'apps/alpha', [
            'cutLegacyCycle:beta',
            'cutLegacyCycle:beta',
        ]);
        expect(resolveCutLegacyCycles(info).problem).toContain('duplicate');
    });
});

describe('deriving a cyclic runtime graph', () => {
    it('fails the derivation rather than emitting a flat graph', () => {
        expect(() => deriveRuntimeGraph(twoServers(true, true))).toThrow(RuleFailError);
    });

    it('a cutLegacyCycle tag on the calling project lets it derive again', () => {
        // Only beta -> alpha is left blocking, so alpha sits at the bottom and beta above it.
        const graph = deriveRuntimeGraph(twoServers(true, true, ['beta']));
        expect(graph.services['alpha'].level).toBe(0);
        expect(graph.services['beta'].level).toBe(1);
    });

    it('KEEPS the cut edge in the emitted graph, marked non-blocking', () => {
        const graph = deriveRuntimeGraph(twoServers(true, true, ['beta']));
        const cut = graph.runtimeEdges.filter(
            (e: RuntimeEdge): boolean => e.from === 'alpha' && e.to === 'beta',
        );
        expect(cut).toHaveLength(1);
        expect(cut[0].cutLegacyCycle).toBe(true);
        // The other direction is a normal, blocking edge and is untouched.
        const other = graph.runtimeEdges.filter(
            (e: RuntimeEdge): boolean => e.from === 'beta' && e.to === 'alpha',
        );
        expect(other).toHaveLength(1);
        expect(other[0].cutLegacyCycle).toBeUndefined();
    });

    it('DRAWS the cut edge, styled as the debt it is', () => {
        const graph = deriveRuntimeGraph(twoServers(true, true, ['beta']));
        const dot = generateRuntimeDot(graph, 'runtime', new RuntimeVizOptions());
        expect(dot).toContain('legacy cycle');
        expect(dot).toContain('style=dashed');
    });
});

describe('a cutLegacyCycle tag that cuts nothing FAILS the build', () => {
    it('names a service nothing answers to', () => {
        const report = deriveRuntimeGraphReport(twoServers(true, false, ['no-such-service']));
        expect(report.problems.join('\n')).toContain(
            "no runtime service answers to 'no-such-service'",
        );
    });

    it('names a real service it has no edge to — the debt is paid, delete the tag', () => {
        const report = deriveRuntimeGraphReport(twoServers(false, false, ['beta']));
        expect(report.problems.join('\n')).toContain('The debt is paid');
    });

    it('is silent when the cut lands', () => {
        const report = deriveRuntimeGraphReport(twoServers(true, true, ['beta']));
        expect(report.problems.filter((p: string): boolean => p.includes('cutLegacyCycle'))).toEqual(
            [],
        );
    });
});

/** Walk up from this spec to the repo root (the directory holding pnpm-workspace.yaml). */
function repoRoot(): string {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
        const parent = path.dirname(dir);
        expect(parent).not.toBe(dir);
        dir = parent;
    }
    return dir;
}

describe("this repo's committed runtime graph", () => {
    it('is acyclic and keeps its existing 0/1/2 levels', () => {
        const file = path.join(repoRoot(), 'architecture', 'runtime-dependencies.json');
        const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeGraph;
        const levels = assignLevels(runtimeAdjacency(graph));
        const committed: Record<string, number> = {};
        for (const name of Object.keys(graph.services)) committed[name] = graph.services[name].level;
        expect(levels).toEqual(committed);
        expect(new Set(Object.values(levels))).toEqual(new Set([0, 1, 2]));
    });
});
