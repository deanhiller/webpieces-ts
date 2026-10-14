import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import type { GraphRenderModel, RenderEdge, RenderNode, RuntimeComparisonView } from '../graph-render-model';
import type { RuntimeGraph } from '../runtime-graph-model';
import { RuntimeNodeLevels } from '../runtime-node-levels';
import { RuntimeGoalComparison } from '../runtime-goal-comparison';
import { RuntimeVizOptions, generateRuntimeRenderModel } from '../runtime-visualizer';
import { FilterFixture } from './graph-filter-fixture';
import { RuntimeGoalFixture } from './runtime-goal-fixture';

/** Actual Graphviz positions and edges, as runtime-layout.spec.ts reads them. */
class OverlayLayout {
    readonly rows = new Map<string, number>();
    readonly edges: string[] = [];

    constructor(dot: string) {
        const plain = execFileSync('dot', ['-Tplain'], { input: dot, encoding: 'utf8' });
        for (const line of plain.split('\n')) {
            const fields = line.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
            const name = (field: string): string => (field.startsWith('"') ? (JSON.parse(field) as string) : field);
            if (fields[0] === 'node') this.rows.set(name(fields[1]), Number(fields[3]));
            if (fields[0] === 'edge') this.edges.push(`${name(fields[1])}->${name(fields[2])}`);
        }
    }

    /** Every higher level strictly above every lower one; one row per level; self-queues just below. */
    checkBands(model: GraphRenderModel): void {
        for (const upper of model.bands) {
            for (const lower of model.bands.filter((band) => band.level < upper.level)) {
                for (const from of upper.nodeNames.filter((id: string) => this.rows.has(id))) {
                    for (const to of lower.nodeNames.filter((id: string) => this.rows.has(id)))
                        expect(this.rows.get(from)!, `${from} above ${to}`).toBeGreaterThan(this.rows.get(to)!);
                }
            }
            const main = upper.nodeNames.filter((id: string) => !upper.selfQueueNames.includes(id) && this.rows.has(id));
            expect(new Set(main.map((id: string) => this.rows.get(id))).size).toBeLessThanOrEqual(1);
        }
    }
}

class Overlay {
    readonly view: RuntimeComparisonView;
    readonly model: GraphRenderModel;

    constructor(current: RuntimeGraph, goal: RuntimeGraph) {
        this.view = new RuntimeGoalComparison().build(current, goal, new RuntimeVizOptions());
        this.model = this.view.model!;
    }

    node(id: string): RenderNode {
        return this.model.nodes.find((node: RenderNode) => node.id === id)!;
    }

    edge(from: string, to: string): RenderEdge {
        return this.model.edges.find((edge: RenderEdge) => edge.from === from && edge.to === to)!;
    }
}

describe('Goal vs Current overlay', () => {
    it('draws additions, removals, changes and context together, with before/after details', () => {
        const fixture = new RuntimeGoalFixture();
        const overlay = new Overlay(fixture.current, fixture.goal);
        expect(overlay.view.available).toBe(true);
        expect(overlay.view.direction).toBe('Current → Goal');
        expect(overlay.view.summary).toMatch(/^\d+ added · \d+ removed · \d+ changed · \d+ unchanged/);
        expect(overlay.node('billing').dot).toContain('added in goal');
        expect(overlay.node('billing').dot).toContain('#1f8a3b');
        const removed = overlay.node('stores-manager');
        expect(removed.dot).toContain('removed from goal');
        expect(removed.dot).toContain('dashed');
        expect(removed.tags).not.toBeNull();
        expect(overlay.edge('stores-manager', 'queue__PublicWebhooksApi').dot).toContain('style=dotted');
        expect(overlay.edge('orders-manager', 'billing').dot).toContain('#1f8a3b');
        expect(overlay.edge('ai-chat', 'pg-dataaccess').dot).toContain('#b4b9c4');
        expect(overlay.node('orders-manager').dot).toMatch(/L4 → L5/);
        expect(overlay.node('queue__PublicWebhooksApi').dot).toMatch(/L3 → L4/);
        expect(overlay.node('queue__WhatsAppApi').dot).toContain('#d88a00');
        const details = overlay.view.nodeDetails['queue__WhatsAppApi'].join('\n');
        expect(details).toContain('selfQueue: true → false');
        expect(details).toContain('producedBy: ai-chat → ai-chat, orders-manager');
        expect(overlay.view.nodeDetails['orders-manager'].join('\n')).toContain('outgoing:');
        const enqueue = overlay.edge('orders-manager', 'queue__WhatsAppApi');
        expect(overlay.view.edgeDetails[enqueue.id].join('\n')).toContain('Enqueue orders-manager → contract-queue:WhatsAppApi — added');
        expect(overlay.view.differences.some((line: string) => line.startsWith('removed: Service stores-manager'))).toBe(true);
    });

    it('lays the overlay out with strict level rows and keeps removed context and both self-queue arrows (real Graphviz)', () => {
        const fixture = new RuntimeGoalFixture();
        const overlay = new Overlay(fixture.current, fixture.goal);
        const layout = new OverlayLayout(overlay.model.fullDot);
        layout.checkBands(overlay.model);
        expect(layout.rows.has('stores-manager')).toBe(true);
        expect(layout.edges).toContain('stores-manager->queue__PublicWebhooksApi');
        expect(layout.edges).toContain('orders-manager->billing');
        expect(layout.edges).toContain('reports-dispatcher->queue__ReportsDispatcherApi');
        expect(layout.edges).toContain('queue__ReportsDispatcherApi->reports-dispatcher');
        expect(layout.rows.get('orders-manager')!).toBeGreaterThan(layout.rows.get('queue__PublicWebhooksApi')!);
        expect(overlay.model.bands.flatMap((band) => band.selfQueueNames)).toContain('queue__ReportsDispatcherApi');
        expect(overlay.model.bands.flatMap((band) => band.selfQueueNames)).not.toContain('queue__WhatsAppApi');
        const rebuilt = FilterFixture.api().dot(overlay.model).render(new Set(overlay.model.nodes.map((node: RenderNode) => node.id)));
        new OverlayLayout(rebuilt).checkBands(overlay.model);
    });

    it('never mistakes an overlay-only cycle for an architectural cycle, and keeps rows ordered', () => {
        const service = RuntimeGoalFixture.service;
        const current: RuntimeGraph = { maxLevel: 0, contractQueues: {}, services: { a: service(), b: service() }, apis: {}, queues: {}, unresolvedUses: [], triggers: [],
            runtimeEdges: [{ from: 'a', to: 'b', via: ['BApi'], type: 'rpc' }] };
        const goal = RuntimeGoalFixture.copy(current);
        goal.runtimeEdges = [{ from: 'b', to: 'a', via: ['AApi'], type: 'rpc' }];
        new RuntimeNodeLevels().apply(current);
        new RuntimeNodeLevels().apply(goal);
        const overlay = new Overlay(current, goal);
        const layout = new OverlayLayout(overlay.model.fullDot);
        layout.checkBands(overlay.model);
        expect(layout.rows.get('b')!).toBeGreaterThan(layout.rows.get('a')!);
        expect(layout.edges).toEqual(expect.arrayContaining(['a->b', 'b->a']));
        expect(overlay.edge('a', 'b').dot).toContain('constraint=false');
        expect(overlay.edge('a', 'b').dot).toContain('style=dotted');
    });

    it('shows identical inputs as an explicit no-differences result with the normal graph context', () => {
        const fixture = new RuntimeGoalFixture();
        const overlay = new Overlay(fixture.current, RuntimeGoalFixture.copy(fixture.current));
        expect(overlay.view.summary).toBe('No differences: the goal matches the current runtime graph.');
        expect(overlay.view.differences).toEqual([]);
        const normal = generateRuntimeRenderModel(fixture.current);
        expect(overlay.model.nodes.map((node: RenderNode) => node.id).sort()).toEqual(normal.nodes.map((node: RenderNode) => node.id).sort());
        expect(overlay.model.nodes.every((node: RenderNode) => !node.dot.includes('#1f8a3b') && !node.dot.includes('#c62828'))).toBe(true);
    });

    it('never merges queues of different diff status into one box', () => {
        const fixture = new RuntimeGoalFixture();
        const current = RuntimeGoalFixture.copy(fixture.current);
        for (const method of ['send', 'retry']) {
            current.queues[`ReportsDispatcherApi.${method}`] = { level: 0, levelBecause: '', selfQueue: false, producedBy: ['orders-manager'], consumedBy: ['reports-dispatcher'], api: 'ReportsDispatcherApi', method, queueName: `ReportsDispatcherApi-${method}` };
            current.runtimeEdges.push({ from: 'orders-manager', to: 'reports-dispatcher', via: ['ReportsDispatcherApi'], type: 'pubsub', queue: `ReportsDispatcherApi.${method}` });
        }
        new RuntimeNodeLevels().apply(current);
        const goal = RuntimeGoalFixture.copy(current);
        goal.queues['ReportsDispatcherApi.retry'].queueName = 'reports-retry';
        const grouped = generateRuntimeRenderModel(current).nodes.filter((node: RenderNode) => node.queueKeys.some((key: string) => key.startsWith('ReportsDispatcherApi.')));
        expect(grouped).toHaveLength(1);
        const overlay = new Overlay(current, goal);
        const split = overlay.model.nodes.filter((node: RenderNode) => node.queueKeys.some((key: string) => key.startsWith('ReportsDispatcherApi.')));
        expect(split.map((node: RenderNode) => node.queueKeys)).toEqual([['ReportsDispatcherApi.retry'], ['ReportsDispatcherApi.send']]);
        expect(overlay.view.nodeDetails[split[0].id].join('\n')).toContain('queueName: ReportsDispatcherApi-retry → reports-retry');
    });

    it('is deterministic for equivalent inputs', () => {
        const fixture = new RuntimeGoalFixture();
        const first = new Overlay(fixture.current, fixture.goal);
        const second = new Overlay(RuntimeGoalFixture.copy(fixture.current), RuntimeGoalFixture.copy(fixture.goal));
        expect(JSON.stringify(second.view)).toBe(JSON.stringify(first.view));
    });
});
