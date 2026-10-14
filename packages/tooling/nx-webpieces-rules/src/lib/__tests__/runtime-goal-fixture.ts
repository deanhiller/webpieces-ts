import type { RuntimeEdge, RuntimeGraph, RuntimeService } from '../runtime-graph-model';
import { RuntimeNodeLevels } from '../runtime-node-levels';
import { RuntimeLayoutFixture } from './runtime-layout-fixture';

/**
 * Current = the #1236 layout fixture (mixed foreign/self PublicWebhooksApi queue, pure self-queues on
 * ReportsDispatcherApi and WhatsAppApi, postgres, a cron sweep). Goal = a proposal that:
 *  - ADDS a `billing` service that orders-manager and public-webhooks call and that calls
 *    pg-dataaccess, which pushes public-webhooks, its queue and orders-manager up a level;
 *  - REMOVES stores-manager (and its enqueue into PublicWebhooksApi);
 *  - turns ai-chat's WhatsAppApi self-queue FOREIGN by having orders-manager enqueue into it, which
 *    moves orders-manager's level.
 * Both graphs are levelled by the generator's own machinery.
 */
export class RuntimeGoalFixture {
    readonly current: RuntimeGraph = new RuntimeLayoutFixture().graph;
    readonly goal: RuntimeGraph;

    constructor() {
        const goal = RuntimeGoalFixture.copy(this.current);
        delete goal.services['stores-manager'];
        goal.runtimeEdges = goal.runtimeEdges.filter((edge: RuntimeEdge) => edge.from !== 'stores-manager');
        goal.services['billing'] = RuntimeGoalFixture.service();
        goal.runtimeEdges.push(
            { from: 'orders-manager', to: 'billing', via: ['BillingApi'], type: 'rpc' },
            { from: 'billing', to: 'pg-dataaccess', via: ['DataApi'], type: 'rpc' },
            { from: 'public-webhooks', to: 'billing', via: ['BillingApi'], type: 'rpc' },
            { from: 'orders-manager', to: 'ai-chat', via: ['WhatsAppApi'], type: 'pubsub' },
        );
        new RuntimeNodeLevels().apply(goal);
        this.goal = goal;
    }

    static service(): RuntimeService {
        return { level: 0, levelBecause: '', role: 'server', products: ['orders'], implements: [], uses: [], dependsOn: [] };
    }

    /** A deep copy, so a spec can mutate one side freely. */
    static copy(graph: RuntimeGraph): RuntimeGraph {
        return JSON.parse(JSON.stringify(graph)) as RuntimeGraph;
    }
}
