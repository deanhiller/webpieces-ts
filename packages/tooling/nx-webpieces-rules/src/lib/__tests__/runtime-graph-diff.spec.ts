import { describe, expect, it } from 'vitest';
import type { RuntimeEdge, RuntimeGraph, RuntimeTrigger } from '../runtime-graph-model';
import { RuntimeNodeLevels } from '../runtime-node-levels';
import { RuntimeDiffStatus, RuntimeFactChange, RuntimeGraphDiff, RuntimeGraphDiffResult } from '../runtime-graph-diff';
import { RuntimeGoalFixture } from './runtime-goal-fixture';

class DiffCheck {
    constructor(readonly result: RuntimeGraphDiffResult) {}

    static of(current: RuntimeGraph, goal: RuntimeGraph): DiffCheck {
        return new DiffCheck(new RuntimeGraphDiff().compare(current, goal));
    }

    status(id: string): RuntimeDiffStatus | undefined {
        return this.result.get(id)?.status;
    }

    fields(id: string): string[] {
        return this.result.get(id)?.changedFields ?? [];
    }
}

/** Reverse every object's key order and every array, recursively: semantically the same graph. */
// webpieces-disable no-any-unknown -- reshuffles arbitrary parsed JSON
function shuffled(value: unknown): unknown {
    if (Array.isArray(value)) return [...value].reverse().map(shuffled);
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) out[key] = shuffled((value as Record<string, unknown>)[key]);
    return out;
}

/** The fixture plus every category it lacks: method queues, remote services, vendor libraries, inbound callers, contracts. */
function wide(): RuntimeGraph {
    const graph = RuntimeGoalFixture.copy(new RuntimeGoalFixture().current);
    graph.apis = {
        DataApi: { implementedBy: ['pg-dataaccess'], usedBy: ['ai-chat', 'public-webhooks'], type: 'rpc', owner: 'data-api' },
        GmailApi: { implementedBy: [], usedBy: ['ai-chat'], type: 'rpc', owner: 'lib-gmail' },
    };
    graph.unresolvedUses = [{ service: 'ai-chat', api: 'GmailApi', level: 0, levelBecause: '' }];
    graph.remoteServices = {
        legacy: { level: 0, levelBecause: '', label: 'Legacy VM', implements: ['LegacyApi (rpc)'], calledBy: [{ from: 'ai-chat', via: ['LegacyApi'], type: 'rpc' }] },
    };
    graph.triggers.push({ level: 0, levelBecause: '', kind: 'external', api: 'WhatsAppApi', method: 'inbound', service: 'ai-chat', caller: { kind: 'saas', label: 'twilio' } });
    graph.queues = {
        'ReportsDispatcherApi.send': { level: 0, levelBecause: '', selfQueue: false, producedBy: ['orders-manager'], consumedBy: ['reports-dispatcher'], api: 'ReportsDispatcherApi', method: 'send', queueName: 'ReportsDispatcherApi-send' },
        'ReportsDispatcherApi.retry': { level: 0, levelBecause: '', selfQueue: false, producedBy: ['orders-manager'], consumedBy: ['reports-dispatcher'], api: 'ReportsDispatcherApi', method: 'retry', queueName: 'ReportsDispatcherApi-retry' },
    };
    graph.runtimeEdges.push(
        { from: 'orders-manager', to: 'reports-dispatcher', via: ['ReportsDispatcherApi'], type: 'pubsub', queue: 'ReportsDispatcherApi.send' },
        { from: 'orders-manager', to: 'reports-dispatcher', via: ['ReportsDispatcherApi'], type: 'pubsub', queue: 'ReportsDispatcherApi.retry' },
    );
    new RuntimeNodeLevels().apply(graph);
    return graph;
}

describe('RuntimeGraphDiff — semantic Current → Goal comparison', () => {
    it('reports identical inputs explicitly, with every fact unchanged', () => {
        const fixture = new RuntimeGoalFixture();
        const check = DiffCheck.of(fixture.current, RuntimeGoalFixture.copy(fixture.current));
        expect(check.result.identical()).toBe(true);
        expect(check.result.differences()).toEqual([]);
        expect(check.result.counts().unchanged).toBe(check.result.changes.length);
    });

    it('ignores object key order and set-like array order', () => {
        const graph = wide();
        const check = DiffCheck.of(graph, shuffled(graph) as RuntimeGraph);
        expect(check.result.differences().map((change: RuntimeFactChange) => change.id)).toEqual([]);
    });

    it('folds duplicate relationship facts the way the graph semantics do', () => {
        const fixture = new RuntimeGoalFixture();
        const goal = RuntimeGoalFixture.copy(fixture.current);
        goal.runtimeEdges.push({ from: 'ai-chat', to: 'pg-dataaccess', via: ['DataApi'], type: 'rpc' });
        goal.runtimeEdges.push({ from: 'ai-chat', to: 'ai-chat', via: ['WhatsAppApi'], type: 'pubsub' });
        expect(DiffCheck.of(fixture.current, goal).result.identical()).toBe(true);
    });

    it('names added and removed services and relationships, and the changed service between them', () => {
        const fixture = new RuntimeGoalFixture();
        const check = DiffCheck.of(fixture.current, fixture.goal);
        expect(check.status('service:billing')).toBe(RuntimeDiffStatus.ADDED);
        expect(check.status('service:stores-manager')).toBe(RuntimeDiffStatus.REMOVED);
        expect(check.status('rpc:orders-manager->billing')).toBe(RuntimeDiffStatus.ADDED);
        expect(check.status('rpc:billing->pg-dataaccess')).toBe(RuntimeDiffStatus.ADDED);
        expect(check.status('enqueue:stores-manager->contract-queue:PublicWebhooksApi')).toBe(RuntimeDiffStatus.REMOVED);
        expect(check.status('rpc:ai-chat->pg-dataaccess')).toBe(RuntimeDiffStatus.UNCHANGED);
        expect(check.fields('service:orders-manager')).toEqual(expect.arrayContaining(['level', 'outgoing']));
        const lines = check.result.get('service:orders-manager')!.lines().join('\n');
        expect(lines).toMatch(/level: L\d → L\d/);
        expect(lines).toContain('billing [BillingApi]');
    });

    it('shows a self-queue turning foreign with its before/after endpoints and level', () => {
        const fixture = new RuntimeGoalFixture();
        const change = new RuntimeGraphDiff().compare(fixture.current, fixture.goal).get('contract-queue:WhatsAppApi')!;
        expect(change.status).toBe(RuntimeDiffStatus.CHANGED);
        expect(change.changedFields).toEqual(expect.arrayContaining(['producedBy', 'selfQueue']));
        expect(change.before!['selfQueue']).toBe('true');
        expect(change.after!['selfQueue']).toBe('false');
        expect(change.before!['producedBy']).toBe('ai-chat');
        expect(change.after!['producedBy']).toBe('ai-chat, orders-manager');
        expect(change.lines().join('\n')).toContain('selfQueue: true → false');
        expect(DiffCheck.of(fixture.goal, fixture.current).status('enqueue:orders-manager->contract-queue:WhatsAppApi')).toBe(RuntimeDiffStatus.REMOVED);
    });

    it('compares grouped method queues per member, before presentation grouping', () => {
        const current = wide();
        const goal = RuntimeGoalFixture.copy(current);
        goal.queues['ReportsDispatcherApi.retry'].queueName = 'reports-retry-override';
        const check = DiffCheck.of(current, goal);
        expect(check.status('queue:ReportsDispatcherApi.send')).toBe(RuntimeDiffStatus.UNCHANGED);
        expect(check.status('queue:ReportsDispatcherApi.retry')).toBe(RuntimeDiffStatus.CHANGED);
        expect(check.fields('queue:ReportsDispatcherApi.retry')).toEqual(['queueName']);
    });

    it('covers external systems, vendor libraries, remote services, triggers and contracts', () => {
        const current = wide();
        const goal = RuntimeGoalFixture.copy(current);
        goal.externalSystems!['postgres'].usedBy.push('ai-chat');
        goal.unresolvedUses = [];
        goal.remoteServices!['legacy'].calledBy = [{ from: 'ai-chat', via: ['LegacyApi', 'AuditApi'], type: 'rpc' }];
        goal.remoteServices!['partner'] = { level: 0, levelBecause: '', implements: ['PartnerApi (pubsub)'], calledBy: [{ from: 'orders-manager', via: ['PartnerApi'], type: 'pubsub' }] };
        goal.triggers = goal.triggers.filter((trigger: RuntimeTrigger) => trigger.kind !== 'cron');
        goal.triggers[0].caller = { kind: 'saas', label: 'vonage' };
        goal.apis['DataApi'].usedBy = ['ai-chat'];
        const check = DiffCheck.of(current, goal);
        expect(check.status('external-system:postgres')).toBe(RuntimeDiffStatus.CHANGED);
        expect(check.status('external-use:ai-chat->external-system:postgres')).toBe(RuntimeDiffStatus.ADDED);
        expect(check.status('external-library:lib-gmail')).toBe(RuntimeDiffStatus.REMOVED);
        expect(check.status('unresolved-use:ai-chat->GmailApi')).toBe(RuntimeDiffStatus.REMOVED);
        expect(check.fields('remote-call:ai-chat->remote-service:legacy#rpc')).toEqual(['via']);
        expect(check.status('remote-service:partner')).toBe(RuntimeDiffStatus.ADDED);
        expect(check.status('remote-call:orders-manager->remote-service:partner#pubsub')).toBe(RuntimeDiffStatus.ADDED);
        expect(check.status('trigger:cron:SweepApi.run@reports-dispatcher')).toBe(RuntimeDiffStatus.REMOVED);
        expect(check.fields('trigger:external:WhatsAppApi.inbound@ai-chat')).toEqual(['caller']);
        expect(check.fields('api:DataApi')).toEqual(['usedBy']);
    });

    it('keeps scoped identities that share a short name apart', () => {
        const fixture = new RuntimeGoalFixture();
        const current = RuntimeGoalFixture.copy(fixture.current);
        current.services['@a/orders'] = RuntimeGoalFixture.service();
        current.services['@b/orders'] = RuntimeGoalFixture.service();
        current.runtimeEdges.push({ from: '@a/orders', to: 'pg-dataaccess', via: ['DataApi'], type: 'rpc' });
        current.runtimeEdges.push({ from: '@b/orders', to: 'pg-dataaccess', via: ['DataApi'], type: 'rpc' });
        new RuntimeNodeLevels().apply(current);
        const goal = RuntimeGoalFixture.copy(current);
        delete goal.services['@b/orders'];
        goal.runtimeEdges = goal.runtimeEdges.filter((edge: RuntimeEdge) => edge.from !== '@b/orders');
        const check = DiffCheck.of(current, goal);
        expect(check.status('service:@a/orders')).toBe(RuntimeDiffStatus.UNCHANGED);
        expect(check.status('service:@b/orders')).toBe(RuntimeDiffStatus.REMOVED);
        expect(check.status('rpc:@a/orders->pg-dataaccess')).toBe(RuntimeDiffStatus.UNCHANGED);
        expect(check.status('rpc:@b/orders->pg-dataaccess')).toBe(RuntimeDiffStatus.REMOVED);
    });

    it('treats explanatory levelBecause text and wiring provenance as bookkeeping, never as a change', () => {
        const fixture = new RuntimeGoalFixture();
        const goal = RuntimeGoalFixture.copy(fixture.current);
        for (const service of Object.values(goal.services)) service.levelBecause = 'hand-written reason';
        goal.services['ai-chat'].wiringUses = [];
        expect(DiffCheck.of(fixture.current, goal).result.identical()).toBe(true);
    });

    it('reports a level change on a retained node as L-before → L-after', () => {
        const fixture = new RuntimeGoalFixture();
        const goal = RuntimeGoalFixture.copy(fixture.current);
        goal.services['pg-dataaccess'].level = 4;
        const change = new RuntimeGraphDiff().compare(fixture.current, goal).get('service:pg-dataaccess')!;
        expect(change.changedFields).toEqual(['level']);
        expect(change.lines()[1]).toBe(`  level: L${fixture.current.services['pg-dataaccess'].level} → L4`);
    });
});
