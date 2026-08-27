/**
 * The RUNTIME-HOST hop on the architecture graph.
 *
 * The failure this closes: a service whose job is to POST our published contract to a URL a PARTNER
 * registered had nothing for the scanner to read, so the most security-sensitive hop in the system —
 * us POSTing to a stranger's server — appeared nowhere at all. Now the client declares its host
 * policy at construction, the scanner reads it, and the destination is drawn as an external node of
 * kind `runtime`.
 *
 * Two levels, because they fail independently: the AST reader that recognises the declaration, and
 * the deriver/visualizer that turn it into a node and an edge.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { runtimeHostOf, targetServiceOf, calleeMethodName } from '../api-usage/api-ast';
import { deriveRuntimeGraph } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import { generateRuntimeDot } from '../runtime-visualizer';

/** The first CallExpression in `source`, which every case below writes as a single statement. */
function firstCall(source: string): ts.CallExpression {
    const file = ts.createSourceFile('t.ts', source, ts.ScriptTarget.Latest, true);
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (found === undefined && ts.isCallExpression(node) && calleeMethodName(node) === 'createRpcClient') {
            found = node;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
    if (found === undefined) {
        throw new Error('no createRpcClient call in the test source');
    }
    return found;
}

describe('runtimeHostOf', () => {
    it('reads the svcName as the identity when the config names a runtime host policy', () => {
        const call = firstCall(
            `f.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks', new RuntimeHostFromContext(r)));`,
        );
        expect(runtimeHostOf(call)).toBe('partner-webhooks');
    });

    it('reads the LONGER permissive policy name too — it is the same stem on purpose', () => {
        const call = firstCall(
            `f.createRpcClient(A, new ClientConfig('local-emulator', new RuntimeHostFromContextAllowingInternalAddresses('why', r)));`,
        );
        expect(runtimeHostOf(call)).toBe('local-emulator');
    });

    it('is null for a deployed-service client, which still reads as a targetService', () => {
        const call = firstCall(`f.createRpcClient(Server2Api, new ClientConfig('server2', new DeployedServiceHost()));`);
        expect(runtimeHostOf(call)).toBeNull();
        expect(targetServiceOf(call)).toBe('server2');
    });

    it('is null when the policy is a variable rather than a named class', () => {
        const call = firstCall(`f.createRpcClient(A, new ClientConfig('svc', policy));`);
        expect(runtimeHostOf(call)).toBeNull();
    });
});

/**
 * `sender` calls a contract nobody in this repo implements, with a RUNTIME host. Before this change
 * that combination produced an `unresolvedUses` entry and a generic grey box; the point of the
 * feature is that it now names the hop.
 */
function graphWithRuntimeHost(): EnhancedGraph {
    return {
        'partner-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        sender: {
            level: 1,
            dependsOn: ['partner-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'partner-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [{ api: 'PartnerWebhookApi', type: 'rpc', runtimeHost: 'partner-webhooks' }],
                },
            },
        },
    };
}

describe('the derived runtime graph', () => {
    const derived = deriveRuntimeGraph(graphWithRuntimeHost());

    it('draws the destination as an external system of kind runtime', () => {
        expect(derived.externalSystems?.['partner-webhooks']).toEqual({
            kind: 'runtime',
            label: 'partner-webhooks',
            usedBy: ['sender'],
            apis: ['PartnerWebhookApi'],
        });
    });

    it('does NOT report it as an unresolved use — it is an answer, not a gap', () => {
        expect(derived.unresolvedUses).toEqual([]);
    });

    it('stamps the contract, so the visualizer stops drawing the generic grey box for it', () => {
        expect(derived.apis['PartnerWebhookApi'].externalSystem).toEqual({
            kind: 'runtime',
            label: 'partner-webhooks',
        });
    });

    it('emits the edge from the calling service to the runtime node', () => {
        const dot = generateRuntimeDot(derived);
        // dotId() maps '-' to '_' in node ids; the LABEL keeps the real identity.
        const edge = dot.split('\n').find((line: string) => line.includes('"sender" -> "system__partner_webhooks"'));
        expect(edge).toBeDefined();
        expect(edge).toContain('label="PartnerWebhookApi"');
        expect(dot).toContain('label="partner-webhooks\\n(external runtime)"');
    });

    it('gives the runtime node its own shape, so it does not read as an ordinary vendor', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).toContain('doubleoctagon');
    });
});

describe('two senders naming ONE runtime identity', () => {
    it('converge on one node with an arrow each, exactly as two @externalSystem contracts do', () => {
        const graph = graphWithRuntimeHost();
        graph['other-sender'] = {
            level: 1,
            dependsOn: ['partner-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'partner-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [{ api: 'PartnerWebhookApi', type: 'rpc', runtimeHost: 'partner-webhooks' }],
                },
            },
        };

        const derived = deriveRuntimeGraph(graph);

        expect(Object.keys(derived.externalSystems ?? {})).toEqual(['partner-webhooks']);
        expect(derived.externalSystems?.['partner-webhooks'].usedBy).toEqual(['other-sender', 'sender']);
    });
});

describe('a graph with no runtime hosts', () => {
    it('is left byte-identical — no empty externalSystems key is written', () => {
        const plain: EnhancedGraph = {
            'partner-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
            sender: {
                level: 1,
                dependsOn: ['partner-api'],
                role: 'server',
                framework: ['node'],
                apiRelations: {
                    'partner-api': {
                        kind: 'uses',
                        implements: [],
                        uses: [{ api: 'PartnerWebhookApi', type: 'rpc' }],
                    },
                },
            },
        };

        const derived = deriveRuntimeGraph(plain);

        expect(derived.externalSystems).toBeUndefined();
        expect(derived.unresolvedUses).toEqual([{ service: 'sender', api: 'PartnerWebhookApi' }]);
    });
});
