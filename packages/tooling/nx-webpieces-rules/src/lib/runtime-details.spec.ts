import { describe, expect, it } from 'vitest';
import { RuntimeNodeLevels } from './runtime-node-levels';
import type { RuntimeGraph } from './runtime-graph-model';
import { deriveRuntimeGraph } from './runtime-graph';
import type { EnhancedGraph } from './graph-sorter';
import { RuntimeDetails } from './runtime-details';
import { generateRuntimeDot, generateRuntimeRenderModel } from './runtime-visualizer';

function graph(apis: string[]): RuntimeGraph {
    return {
        maxLevel: 2,
        contractQueues: {},
        services: {
            source: {
                level: 2,
                levelBecause: 'rpc:target (L1)',
                role: 'client',
                implements: [],
                uses: [...apis],
                dependsOn: [],
            },
            target: {
                level: 1,
                levelBecause: 'no callees',
                role: 'server',
                implements: [...apis],
                uses: [],
                dependsOn: [],
                implementsVia: Object.fromEntries(apis.map((api) => [api, 'shared#Routes'])),
            },
        },
        apis: Object.fromEntries(
            apis.map((api) => [
                api,
                {
                    owner: 'contracts',
                    implementedBy: ['target'],
                    usedBy: ['source'],
                    type: 'rpc' as const,
                },
            ]),
        ),
        runtimeEdges:
            apis.length === 0
                ? []
                : [{ from: 'source', to: 'target', via: [...apis], type: 'rpc' }],
        queues: {},
        triggers: [],
        unresolvedUses: [],
    };
}

describe('compact runtime graph details', () => {
    it('shows one contract use on both queue hops without DI paths or method guesses', () => {
        const via = 'source#AppWiring/0:source#AppWiring/bindModules[0]:source#BindModule';
        const projects: EnhancedGraph = {
            contracts: { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
            source: {
                level: 1,
                dependsOn: ['contracts'],
                role: 'server',
                framework: ['node'],
                apiRelations: {
                    contracts: {
                        kind: 'uses',
                        implements: [],
                        uses: [
                            {
                                api: 'MailApi',
                                type: 'pubsub',
                                targetService: 'target',
                                declaredVia: via,
                            },
                        ],
                    },
                },
            },
            target: {
                level: 1,
                dependsOn: ['contracts'],
                role: 'server',
                framework: ['node'],
                serviceName: 'target',
                apiRelations: {
                    contracts: {
                        kind: 'implements',
                        uses: [],
                        implements: [{ api: 'MailApi', type: 'pubsub' }],
                    },
                },
            },
        };
        const data = deriveRuntimeGraph(projects, new Set(), {
            MailApi: {
                owner: 'contracts',
                apiKind: 'pubsub',
                basePath: '/mail',
                methods: ['deliver', 'fanout', 'menuPublicationCompleted'].map((name) => ({
                    name,
                    path: `/${name}`,
                    kind: 'cloudtasks',
                    operation: 'write',
                    queueName: name,
                })),
            },
        });
        const details = new RuntimeDetails(data, true, generateRuntimeRenderModel(data));
        const expected = ['contracts#MailApi → target (pubsub)'];
        expect(details.nodes.source.used).toEqual(expected);
        expect(details.edges['source->queue__MailApi']).toEqual(['contracts#MailApi']);
        expect(details.edges['queue__MailApi->target']).toEqual(['contracts#MailApi']);
        expect(JSON.stringify(details)).not.toContain(via);
        expect(JSON.stringify(details)).not.toContain('inferred');
        expect(data.queues).toEqual({});
        expect(data.runtimeEdges).toEqual([
            { from: 'source', to: 'target', type: 'pubsub', via: ['MailApi'] },
        ]);
    });
    it('matches exact queue identities when method names share a prefix', () => {
        const data = graph(['MailApi', 'OtherApi']);
        data.services.second = { ...data.services.target };
        data.runtimeEdges = [
            {
                from: 'source',
                to: 'target',
                via: ['MailApi'],
                type: 'pubsub',
                queue: 'MailApi.send',
            },
            {
                from: 'source',
                to: 'second',
                via: ['OtherApi'],
                type: 'pubsub',
                queue: 'MailApi.sendEmail',
            },
        ];
        for (const edge of data.runtimeEdges) {
            data.queues[edge.queue!] = {
                level: 2,
                levelBecause: 'above consumer',
                selfQueue: false,
                api: edge.via[0],
                method: edge.queue!.split('.')[1],
                queueName: edge.queue!,
                producedBy: [edge.from],
                consumedBy: [edge.to],
            };
        }
        new RuntimeNodeLevels().apply(data);
        const model = generateRuntimeRenderModel(data);
        const details = new RuntimeDetails(data, true, model);
        const longer = details.edges['source->queue__MailApi_sendEmail'];
        expect(longer).toEqual(['contracts#OtherApi']);
        expect(details.edges['source->queue__MailApi_send']).toEqual(['contracts#MailApi']);
    });
    for (const count of [0, 1, 2, 3, 10]) {
        it(`keeps ${count} edge relationships complete with the correct inline/dropdown threshold`, () => {
            const apis = Array.from({ length: count }, (_, index) => `Api${index}`);
            const data = graph(apis);
            const details = new RuntimeDetails(data, true);
            const dot = generateRuntimeDot(data);
            expect(details.nodes.source.used).toHaveLength(count);
            expect(details.nodes.target.implemented).toHaveLength(count);
            if (count > 1) expect(dot).toContain(`label="Uses (${count}) ▾"`);
            else if (count > 0) expect(dot).toContain(`label="${apis.join(', ')}"`);
            expect(dot).toContain(`Implements (${count})`);
            expect(details.nodes.target.implemented).toEqual(apis.map((api) => `contracts#${api}`));
            expect(details.edges['source->target'] ?? []).toEqual(
                apis.map((api) => `contracts#${api}`),
            );
        });
    }
    it('renders one Implements row for one registration with wiring provenance', () => {
        const data = graph(['UberEatsApi']);
        data.services.target.wiringImplements = [
            { api: 'UberEatsApi', type: 'rpc', declaredVia: 'target#Wiring/0:Routes' },
        ];
        const details = new RuntimeDetails(data, true);
        expect(details.nodes.target.implemented).toEqual(['contracts#UberEatsApi']);
        expect(generateRuntimeDot(data)).toContain('Implements (1)');
        // Saved duplicate identities cannot make the box count disagree with its popup.
        data.services.target.implements.push('UberEatsApi');
        expect(new RuntimeDetails(data, true).nodes.target.implemented).toEqual([
            'contracts#UberEatsApi',
        ]);
        expect(generateRuntimeDot(data)).toContain('Implements (1)');
    });
    it('converges multiple enqueuers by contract and keeps each popup scoped to its API', () => {
        const data = graph(['MailApi', 'OtherApi']);
        data.services.second = { ...data.services.source };
        data.runtimeEdges = [
            { from: 'source', to: 'target', via: ['MailApi', 'OtherApi'], type: 'pubsub' },
            { from: 'second', to: 'target', via: ['MailApi'], type: 'pubsub' },
        ];
        new RuntimeNodeLevels().apply(data);
        const model = generateRuntimeRenderModel(data);
        const queues = model.nodes.filter((node) => node.queueKeys.length > 0);
        expect(queues.map((node) => node.queueKeys)).toEqual([
            ['queue:MailApi'],
            ['queue:OtherApi'],
        ]);
        expect(queues[0].dot).toContain('MailApi queue');
        expect(
            model.edges.filter((edge) => edge.to === 'queue__MailApi').map((edge) => edge.from),
        ).toEqual(['second', 'source']);
        expect(
            model.edges.filter((edge) => edge.from === 'queue__MailApi').map((edge) => edge.to),
        ).toEqual(['target']);
        const details = new RuntimeDetails(data, true, model);
        expect(details.edges['source->queue__MailApi']).toEqual(['contracts#MailApi']);
        expect(details.edges['second->queue__MailApi']).toEqual(['contracts#MailApi']);
        expect(details.edges['source->queue__OtherApi']).toEqual(['contracts#OtherApi']);
        expect(details.edges['queue__MailApi->target']).toEqual(['contracts#MailApi']);
    });
    it('retains two providers of one API and hidden external uses in the node list', () => {
        const data = graph(['AuthApi']);
        data.runtimeEdges.push({ from: 'source', to: 'second', via: ['AuthApi'], type: 'rpc' });
        data.services.source.uses.push('GmailApi');
        data.apis.GmailApi = {
            owner: 'gmail',
            type: 'external',
            implementedBy: [],
            usedBy: ['source'],
        };
        const details = new RuntimeDetails(data, false);
        expect(details.nodes.source.used).toHaveLength(3);
        expect(details.nodes.source.used.join('\n')).toContain('→ second');
        expect(details.nodes.source.used.join('\n')).toContain('destination hidden');
        expect(details.edges['source->target']).toHaveLength(1);
        expect(details.edges['source->second']).toHaveLength(1);
    });
});
