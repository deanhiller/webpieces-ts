/**
 * Tests the runtime graph DERIVED from dependencies.json (per-project apiRelations): an rpc API
 * becomes a direct runtime edge; a pubsub API becomes an edge drawn producer -> queue -> consumer.
 * Both architecture:generate and architecture:validate-runtime-architecture call deriveRuntimeGraph
 * over the SAME EnhancedGraph, so they can never diverge.
 */

import { describe, it, expect } from 'vitest';
import { deriveRuntimeGraph, serializeRuntimeGraph } from '../runtime-graph';
import type { RuntimeEdge } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import { generateRuntimeDot } from '../runtime-visualizer';

/**
 * An EnhancedGraph like the one dependencies.json holds: `producer` uses two APIs owned by the
 * `shared-api` api-lib; `consumer` implements both. Transport comes from each ApiRef's `type`.
 */
function graph(): EnhancedGraph {
    return {
        'shared-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        producer: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'shared-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [
                        { api: 'EmailApi', type: 'pubsub' },
                        { api: 'RpcApi', type: 'rpc' },
                    ],
                },
            },
        },
        consumer: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'shared-api': {
                    kind: 'implements',
                    implements: [
                        { api: 'EmailApi', type: 'pubsub' },
                        { api: 'RpcApi', type: 'rpc' },
                    ],
                    uses: [],
                },
            },
        },
    };
}

describe('deriveRuntimeGraph', () => {
    const derived = deriveRuntimeGraph(graph());

    it('records each API by CLASS name with its transport', () => {
        expect(derived.apis['EmailApi'].type).toBe('pubsub');
        expect(derived.apis['EmailApi'].implementedBy).toEqual(['consumer']);
        expect(derived.apis['EmailApi'].usedBy).toEqual(['producer']);
        expect(derived.apis['RpcApi'].type).toBe('rpc');
    });

    it('splits producer→consumer into one rpc edge and one pubsub edge', () => {
        const edges = derived.runtimeEdges.filter((e: RuntimeEdge) => e.from === 'producer' && e.to === 'consumer');
        expect(edges).toHaveLength(2);
        const rpc = edges.find((e: RuntimeEdge) => e.type === 'rpc');
        const pubsub = edges.find((e: RuntimeEdge) => e.type === 'pubsub');
        expect(rpc?.via).toEqual(['RpcApi']);
        expect(pubsub?.via).toEqual(['EmailApi']);
    });

    it('records service implements/uses at api-class granularity', () => {
        expect(derived.services['producer'].uses.sort()).toEqual(['EmailApi', 'RpcApi']);
        expect(derived.services['consumer'].implements.sort()).toEqual(['EmailApi', 'RpcApi']);
    });

    it('ignores projects with no apiRelations (the api-lib itself is not a runtime node)', () => {
        expect(derived.services['shared-api']).toBeUndefined();
    });
});

describe('generate and validate derive the SAME graph from dependencies.json', () => {
    it('is byte-identical when derived from the graph vs a JSON round-trip of it (what validate loads)', () => {
        const fromMemory = deriveRuntimeGraph(graph());
        // Mimic validate: it loads the committed dependencies.json (a JSON round-trip of the graph).
        const roundTripped = JSON.parse(JSON.stringify(graph())) as EnhancedGraph;
        const fromDisk = deriveRuntimeGraph(roundTripped);
        expect(serializeRuntimeGraph(fromDisk)).toBe(serializeRuntimeGraph(fromMemory));
    });
});

describe('drawOnGraph:false hides a service from the runtime render but keeps it in the JSON', () => {
    const derived = deriveRuntimeGraph(graph(), new Set(['consumer']));

    it('flags the hidden service in the graph data (kept, not dropped)', () => {
        expect(derived.services['consumer'].drawOnGraph).toBe(false);
        expect(derived.services['producer'].drawOnGraph).toBeUndefined();
    });

    it('omits the hidden node and every edge/queue touching it from the DOT', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).not.toContain('"consumer" [');
        expect(dot).not.toContain('-> "consumer"');
        expect(dot).not.toContain('queue__producer__consumer');
        expect(dot).toContain('"producer" [');
    });
});

describe('generateRuntimeDot — rpc direct, pubsub via queue', () => {
    const dot = generateRuntimeDot(deriveRuntimeGraph(graph()));

    it('draws the rpc edge as a direct labeled arrow', () => {
        expect(dot).toContain('"producer" -> "consumer" [label="RpcApi"];');
    });

    it('draws the pubsub edge through a cylinder queue node', () => {
        expect(dot).toContain('"queue__producer__consumer" [shape=cylinder');
        expect(dot).toContain('"producer" -> "queue__producer__consumer" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__producer__consumer" -> "consumer" [label="deliver", style=dashed];');
    });
});
