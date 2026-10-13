import { describe, expect, it } from 'vitest';
import type { RuntimeGraph } from './runtime-graph-model';
import { deriveRuntimeGraph } from './runtime-graph';
import type { EnhancedGraph } from './graph-sorter';
import { RuntimeDetails } from './runtime-details';
import { generateRuntimeDot, generateRuntimeRenderModel } from './runtime-visualizer';

function graph(apis: string[]): RuntimeGraph {
    return {
        services: {
            source: { level: 1, role: 'client', implements: [], uses: [...apis], dependsOn: [] },
            target: {
                level: 0,
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
        expect(details.edges['source->queue__source__target']).toEqual(expected);
        expect(details.edges['queue__source__target->target']).toEqual(expected);
        expect(JSON.stringify(details)).not.toContain(via);
        expect(JSON.stringify(details)).not.toContain('inferred');
        expect(data.queues).toEqual({});
        expect(data.runtimeEdges).toEqual([
            { from: 'source', to: 'target', type: 'pubsub', via: ['MailApi'] },
        ]);
    });
    it('matches exact queue identities when method names share a prefix', () => {
        const data = graph(['MailApi']);
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
                via: ['MailApi'],
                type: 'pubsub',
                queue: 'MailApi.sendEmail',
            },
        ];
        const model = generateRuntimeRenderModel(data);
        const details = new RuntimeDetails(data, true, model);
        const longer = details.edges['source->queue__MailApi_sendEmail'];
        expect(longer.join('\n')).toContain('→ second');
        expect(longer.join('\n')).not.toContain('→ target');
        expect(details.edges['source->queue__MailApi_send'].join('\n')).not.toContain('→ second');
    });
    for (const count of [0, 1, 2, 3, 10]) {
        it(`keeps ${count} edge relationships complete with the correct inline/dropdown threshold`, () => {
            const apis = Array.from({ length: count }, (_, index) => `Api${index}`);
            const data = graph(apis);
            const details = new RuntimeDetails(data, true);
            const dot = generateRuntimeDot(data);
            expect(details.nodes.source.used).toHaveLength(count);
            expect(details.nodes.target.implemented).toHaveLength(count);
            if (count > 2) expect(dot).toContain(`label="Uses (${count}) ▾"`);
            else if (count > 0) expect(dot).toContain(`label="${apis.join(', ')}"`);
            expect(dot).toContain(`Implements (${count})`);
            expect(
                details.nodes.target.implemented.every((value) =>
                    value.includes('via shared#Routes'),
                ),
            ).toBe(true);
        });
    }
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
