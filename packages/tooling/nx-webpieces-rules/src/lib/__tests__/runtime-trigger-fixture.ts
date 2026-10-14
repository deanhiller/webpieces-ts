import type { RuntimeGraph } from '../runtime-graph-model';

/** The reported shape: nine APIs, thirty-three methods, and a second service. */
export class RuntimeTriggerFixture {
    readonly graph: RuntimeGraph = {
        maxLevel: 2,
        contractQueues: {},
        services: {
            public: {
                level: 1,
                levelBecause: 'no callees',
                role: 'server',
                implements: [],
                uses: [],
                dependsOn: [],
            },
            second: {
                level: 1,
                levelBecause: 'no callees',
                role: 'server',
                implements: [],
                uses: [],
                dependsOn: [],
            },
        },
        apis: {},
        runtimeEdges: [],
        triggers: [],
        queues: {},
        unresolvedUses: [],
    };

    constructor() {
        for (let index = 0; index < 9; index++) {
            const api = `Api${index}`;
            this.graph.apis[api] = { owner: 'contracts', implementedBy: ['public'], usedBy: [] };
            this.graph.services.public.implements.push(api);
        }
        for (let index = 0; index < 33; index++) {
            this.graph.triggers.push({
                level: 2,
                levelBecause: 'above every non-trigger node (L1)',
                kind: 'external',
                api: `Api${index % 9}`,
                method: `method${index}`,
                service: 'public',
                caller: { kind: 'saas', label: 'external customers' },
            });
        }
        this.graph.triggers.push({
            level: 2,
            levelBecause: 'above every non-trigger node (L1)',
            kind: 'external',
            api: 'Api0',
            method: 'receive',
            service: 'second',
            caller: { kind: 'saas', label: 'external customers' },
        });
    }
}
