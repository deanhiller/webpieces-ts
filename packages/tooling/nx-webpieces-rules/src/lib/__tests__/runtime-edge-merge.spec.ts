import * as fs from 'fs';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphRenderModel, RenderEdge } from '../graph-render-model';
import type { RuntimeEdge, RuntimeGraph } from '../runtime-graph-model';
import { RuntimeDetails } from '../runtime-details';
import { RuntimeEdgeMerge } from '../runtime-edge-merge';
import { DEFAULT_RUNTIME_GOAL_PATH, RuntimeGoalFile } from '../runtime-goal-file';
import { RuntimeGoalComparison } from '../runtime-goal-comparison';
import { saveRuntimeGraph } from '../runtime-graph-io';
import { RuntimeUnionGraph } from '../runtime-union-graph';
import { RuntimeVizOptions, generateRuntimeRenderModel } from '../runtime-visualizer';
import { RuntimeGoalFixture } from './runtime-goal-fixture';

const SPLIT = ['BillingApi', 'InvoiceApi', 'LedgerApi'];

/**
 * #1370: a hand-authored goal listing ONE pair once per contract (orders-manager -> billing three
 * times) — exactly the shape the portal-gateway -> delivery-partner-outbound goal had.
 */
// webpieces-disable no-function-outside-class -- spec fixture builder
function splitGoal(): RuntimeGraph {
    const goal = RuntimeGoalFixture.copy(new RuntimeGoalFixture().goal);
    goal.runtimeEdges = goal.runtimeEdges.filter((edge: RuntimeEdge) => !(edge.from === 'orders-manager' && edge.to === 'billing'));
    for (const api of ['LedgerApi', 'BillingApi', 'InvoiceApi'])
        goal.runtimeEdges.push({ from: 'orders-manager', to: 'billing', via: [api], type: 'rpc' });
    return goal;
}

// webpieces-disable no-function-outside-class -- spec helper
function drawn(model: GraphRenderModel, from: string, to: string): RenderEdge[] {
    return model.edges.filter((edge: RenderEdge) => edge.from === from && edge.to === to);
}

const roots: string[] = [];

// webpieces-disable no-function-outside-class -- spec helper
function loadedGoal(goal: RuntimeGraph): RuntimeGraph {
    const root = specTempDirs.make('wp-edge-merge-');
    roots.push(root);
    saveRuntimeGraph(goal, root, DEFAULT_RUNTIME_GOAL_PATH);
    return new RuntimeGoalFile().load(root);
}

describe('one edge per (transport, from, to, queue) — #1370', () => {
    afterEach(() => {
        for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    it('merges N edges between the same two services into one carrying every contract, without mutating its input', () => {
        const edges: RuntimeEdge[] = [
            { from: 'a', to: 'b', via: ['ZApi'], type: 'rpc' },
            { from: 'a', to: 'b', via: ['AApi'], type: 'rpc' },
            { from: 'a', to: 'b', via: ['ZApi', 'MApi'], type: 'rpc' },
            { from: 'a', to: 'b', via: ['QApi'], type: 'pubsub' },
        ];
        const merged = new RuntimeEdgeMerge().merge(edges);
        expect(merged).toEqual([
            { from: 'a', to: 'b', via: ['AApi', 'MApi', 'ZApi'], type: 'rpc' },
            { from: 'a', to: 'b', via: ['QApi'], type: 'pubsub' },
        ]);
        expect(edges[0].via).toEqual(['ZApi']);
    });

    it('draws N apis between the same two services in a goal file as ONE arrow labelled Uses (N), whose popup lists all N', () => {
        const goal = loadedGoal(splitGoal());
        const model = generateRuntimeRenderModel(goal, 'goal', new RuntimeVizOptions());
        const edges = drawn(model, 'orders-manager', 'billing');
        expect(edges).toHaveLength(1);
        expect(edges[0].dot).toContain('label="Uses (3) ▾"');
        const details = new RuntimeDetails(goal, true, model);
        expect(details.edges['orders-manager->billing'].map((entry: string) => entry.split('#')[1]).sort()).toEqual(SPLIT);
    });

    it('draws ONE arrow per pair in the Goal vs Current overlay too, carrying both graphs\' contracts', () => {
        const fixture = new RuntimeGoalFixture();
        const view = new RuntimeGoalComparison().build(fixture.current, loadedGoal(splitGoal()), new RuntimeVizOptions());
        const edges = drawn(view.model!, 'orders-manager', 'billing');
        expect(edges).toHaveLength(1);
        expect(edges[0].dot).toContain('Uses (3) ▾');
        const union = new RuntimeUnionGraph().build(fixture.current, splitGoal());
        const pair = union.runtimeEdges.filter((edge: RuntimeEdge) => edge.from === 'orders-manager' && edge.to === 'billing');
        expect(pair).toHaveLength(1);
        expect(pair[0].via).toEqual(SPLIT);
    });
});
