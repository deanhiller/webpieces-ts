/**
 * The RUNTIME-HOST hop on the architecture graph.
 *
 * The failure this closes: a service whose job is to POST our published contract to a URL a PARTNER
 * registered had nothing for the scanner to read, so the most security-sensitive hop in the system —
 * us POSTing to a stranger's server — appeared nowhere at all.
 *
 * It is declared where every other outbound vendor seam is declared: an `@externalSystem` JSDoc tag
 * on the CONTRACT, with kind `runtime`. On the contract rather than at the `createRpcClient` call
 * site, because "the far end of this contract is outside our estate" is true for every caller of it
 * — one declaration however many services deliver over it — and because it then rides the exact same
 * declare → resolve → draw pipeline `saas` and `database` already ride, instead of a second
 * mechanism reading construction sites that can disagree with the first.
 *
 * Two levels, because they fail independently: the AST reader that recognises the tag, and the
 * deriver/visualizer that turn it into a node and an edge.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { externalSystemTagFrom } from '../api-usage/api-ast';
import { deriveRuntimeGraphReport } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import type { ExternalSystemDecls } from '../api-usage/api-relations';
import { generateRuntimeDot } from '../runtime-visualizer';

/** The first class/interface declaration in `source`, so a JSDoc tag can be read off it. */
function firstDeclaration(source: string): ts.Node {
    const file = ts.createSourceFile('t.ts', source, ts.ScriptTarget.Latest, true);
    let found: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
        if (found === undefined && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))) {
            found = node;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
    if (found === undefined) {
        throw new Error('no class or interface in the test source');
    }
    return found;
}

describe('the @externalSystem runtime tag', () => {
    it('reads kind and identity off the contract', () => {
        const node = firstDeclaration(
            `/** @externalSystem runtime partner-webhooks */\nexport abstract class PartnerWebhookApi {}`,
        );
        expect(externalSystemTagFrom(node, 'PartnerWebhookApi')).toEqual({
            kind: 'runtime',
            label: 'partner-webhooks',
        });
    });

    it('is null on a contract that declares nothing — an ordinary in-repo peer', () => {
        const node = firstDeclaration(`export abstract class Server2Api {}`);
        expect(externalSystemTagFrom(node, 'Server2Api')).toBeNull();
    });
});

/**
 * `sender` delivers over a contract nobody in this repo implements, declared `runtime`. Before the
 * feature that combination produced only a generic grey box; the point is that it now NAMES the hop.
 */
function graphWithSender(): EnhancedGraph {
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
                    uses: [{ api: 'PartnerWebhookApi', type: 'rpc' }],
                },
            },
        },
    };
}

/** What the scanner writes into dependencies.json for that `@externalSystem runtime` tag. */
function runtimeDecls(): ExternalSystemDecls {
    return {
        'partner-webhooks': {
            kind: 'runtime',
            label: 'partner-webhooks',
            apis: ['PartnerWebhookApi'],
            projects: [],
        },
    };
}

describe('the derived runtime graph', () => {
    const derived = deriveRuntimeGraphReport(graphWithSender(), new Set<string>(), {}, runtimeDecls()).graph;

    it('draws the destination as an external system of kind runtime', () => {
        expect(derived.externalSystems?.['partner-webhooks']).toEqual({
            kind: 'runtime',
            label: 'partner-webhooks',
            usedBy: ['sender'],
            apis: ['PartnerWebhookApi'],
        });
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

    it('draws the hop ONCE — the unresolved entry is stamped, so no second grey box appears', () => {
        // The `uses` still lands in unresolvedUses, exactly as every other @externalSystem contract's
        // does: nothing in-repo implements it, which is the literal truth the field records. What
        // stops it being DRAWN twice is the stamp above — the visualizer skips an unresolved entry
        // whose contract carries an externalSystem. Keeping that one rule, rather than a second
        // suppression path just for `runtime`, is the whole point of routing this through the
        // existing declaration pipeline.
        expect(derived.unresolvedUses).toEqual([{ service: 'sender', api: 'PartnerWebhookApi' }]);
        const dot = generateRuntimeDot(derived);
        // Node DEFINITIONS only — a line that starts with the id (an edge line starts with its source).
        const definitions = dot
            .split('\n')
            .filter((line: string) => line.trim().startsWith('"system__partner_webhooks" ['));
        expect(definitions).toHaveLength(1);
    });
});

describe('two senders naming ONE runtime identity', () => {
    it('converge on one node with an arrow each, exactly as two @externalSystem saas contracts do', () => {
        const graph = graphWithSender();
        graph['other-sender'] = {
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
        };

        const derived = deriveRuntimeGraphReport(graph, new Set<string>(), {}, runtimeDecls()).graph;

        expect(Object.keys(derived.externalSystems ?? {})).toEqual(['partner-webhooks']);
        expect(derived.externalSystems?.['partner-webhooks'].usedBy).toEqual(['other-sender', 'sender']);
    });
});

describe('a graph with nothing declared', () => {
    it('is left byte-identical — no empty externalSystems key is written', () => {
        const derived = deriveRuntimeGraphReport(graphWithSender()).graph;

        expect(derived.externalSystems).toBeUndefined();
        expect(derived.unresolvedUses).toEqual([{ service: 'sender', api: 'PartnerWebhookApi' }]);
    });
});
