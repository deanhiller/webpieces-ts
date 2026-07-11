/**
 * Tests the scan-derived runtime graph + its queue rendering: an rpc API becomes a direct runtime
 * edge; a pubsub API becomes an edge drawn producer -> queue -> consumer.
 */

import { describe, it, expect } from 'vitest';
import { assembleRuntimeGraphFromScan } from '../runtime-graph';
import type { RuntimeEdge } from '../runtime-graph';
import { generateRuntimeDot } from '../runtime-visualizer';
import type { ApiScanResult } from '../api-usage/api-scanner';
import type { ApiRef } from '../api-usage/api-relations';

type Relation = { kind: 'implements' | 'uses' | 'uses-implements'; implements: ApiRef[]; uses: ApiRef[] };

function scan(): ApiScanResult {
    const apiIndex = new Map<string, { api: string; owner: string; type: 'rpc' | 'pubsub' }>();
    apiIndex.set('EmailApi', { api: 'EmailApi', owner: 'shared-api', type: 'pubsub' });
    apiIndex.set('RpcApi', { api: 'RpcApi', owner: 'shared-api', type: 'rpc' });

    const relationsByProject = new Map<string, Record<string, Relation>>();
    relationsByProject.set('producer', {
        'shared-api': { kind: 'uses', implements: [], uses: [{ api: 'EmailApi', type: 'pubsub' }, { api: 'RpcApi', type: 'rpc' }] },
    });
    relationsByProject.set('consumer', {
        'shared-api': { kind: 'implements', implements: [{ api: 'EmailApi', type: 'pubsub' }, { api: 'RpcApi', type: 'rpc' }], uses: [] },
    });

    return {
        relationsByProject,
        apiLibProjects: new Set(['shared-api']),
        apiIndex,
        scannedProjects: new Set(['producer', 'consumer']),
    };
}

describe('assembleRuntimeGraphFromScan', () => {
    const graph = assembleRuntimeGraphFromScan(scan());

    it('records each API with its transport', () => {
        expect(graph.apis['EmailApi'].type).toBe('pubsub');
        expect(graph.apis['EmailApi'].implementedBy).toEqual(['consumer']);
        expect(graph.apis['EmailApi'].usedBy).toEqual(['producer']);
        expect(graph.apis['RpcApi'].type).toBe('rpc');
    });

    it('splits producer→consumer into one rpc edge and one pubsub edge', () => {
        const edges = graph.runtimeEdges.filter((e: RuntimeEdge) => e.from === 'producer' && e.to === 'consumer');
        expect(edges).toHaveLength(2);
        const rpc = edges.find((e: RuntimeEdge) => e.type === 'rpc');
        const pubsub = edges.find((e: RuntimeEdge) => e.type === 'pubsub');
        expect(rpc?.via).toEqual(['RpcApi']);
        expect(pubsub?.via).toEqual(['EmailApi']);
    });

    it('records service implements/uses at api-class granularity', () => {
        expect(graph.services['producer'].uses.sort()).toEqual(['EmailApi', 'RpcApi']);
        expect(graph.services['consumer'].implements.sort()).toEqual(['EmailApi', 'RpcApi']);
    });
});

describe('drawOnGraph:false hides a service from the runtime render but keeps it in the JSON', () => {
    const graph = assembleRuntimeGraphFromScan(scan(), new Set(['consumer']));

    it('flags the hidden service in the graph data (kept, not dropped)', () => {
        expect(graph.services['consumer'].drawOnGraph).toBe(false);
        expect(graph.services['producer'].drawOnGraph).toBeUndefined();
    });

    it('omits the hidden node and every edge/queue touching it from the DOT', () => {
        const dot = generateRuntimeDot(graph);
        expect(dot).not.toContain('"consumer" [');
        expect(dot).not.toContain('-> "consumer"');
        expect(dot).not.toContain('queue__producer__consumer');
        // the visible producer node still renders
        expect(dot).toContain('"producer" [');
    });
});

describe('generateRuntimeDot — rpc direct, pubsub via queue', () => {
    const dot = generateRuntimeDot(assembleRuntimeGraphFromScan(scan()));

    it('draws the rpc edge as a direct labeled arrow', () => {
        expect(dot).toContain('"producer" -> "consumer" [label="RpcApi"];');
    });

    it('draws the pubsub edge through a cylinder queue node', () => {
        expect(dot).toContain('"queue__producer__consumer" [shape=cylinder');
        expect(dot).toContain('"producer" -> "queue__producer__consumer" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__producer__consumer" -> "consumer" [label="deliver", style=dashed];');
    });
});
