/**
 * WHO calls an `external` endpoint — read from `@Endpoint(p, 'external', { calledBy })`, carried onto
 * the trigger, and drawn as the INBOUND box.
 *
 * The bug this closes: that box named OUR OWN contract (`WhatsAppApi`), which the service box the
 * arrow points at already prints, while the single fact it exists to convey — that Twilio is posting
 * to us — appeared nowhere. Two vendors on one contract also collapsed into one box, because the id
 * came from the api name.
 *
 * The cases worth pinning are the ones a reader would get wrong by guessing: that identity comes from
 * the CALLER (so one vendor is one box and two vendors are two), that inbound and outbound share that
 * identity (so a vendor we both call and are called by is ONE box), that a caller is recorded only
 * for `external`, and that an unreadable caller FAILS generation rather than degrading the diagram.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { DecoratorArgDiagnostics, endpointMethodsOf, stringConstantsOf } from '../api-usage/api-ast';
import type { ApiContracts, ApiMethodMeta } from '../api-usage/api-relations';
import { UndeclaredExternalCallerError } from '../api-usage/api-contract-errors';
import { deriveRuntimeGraph } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph, RuntimeService } from '../runtime-graph-model';
import { attachExternalSystems } from '../api-usage/external-systems';
import { generateRuntimeDot, RuntimeVizOptions } from '../runtime-visualizer';

/** Parse `source`, hand its FIRST class to endpointMethodsOf, and return the methods + diagnostics. */
class Scanned {
    constructor(
        public readonly methods: ApiMethodMeta[],
        public readonly diagnostics: DecoratorArgDiagnostics,
    ) {}
}

function scan(source: string, api: string = 'HookApi'): Scanned {
    const file = ts.createSourceFile('/ws/libraries/hook-api/src/index.ts', source, ts.ScriptTarget.Latest, true);
    const diagnostics = new DecoratorArgDiagnostics('/ws');
    let cls: ts.ClassDeclaration | null = null;
    const walk = (node: ts.Node): void => {
        if (cls === null && ts.isClassDeclaration(node)) cls = node;
        ts.forEachChild(node, walk);
    };
    walk(file);
    const methods = endpointMethodsOf(cls!, api, stringConstantsOf(file), diagnostics);
    return new Scanned(methods, diagnostics);
}

function byName(methods: ApiMethodMeta[], name: string): ApiMethodMeta {
    return methods.find((m: ApiMethodMeta) => m.name === name)!;
}

describe('reading calledBy / callerKind out of the @Endpoint options literal', () => {
    it('parses a caller into the (kind, label) pair, defaulting the kind to saas', () => {
        const scanned = scan(`
@ApiPath('/hooks')
export abstract class HookApi {
    @Endpoint('/inbound', 'external', { formPost: true, calledBy: 'twilio' })
    abstract inbound(): Promise<void>;
}`);
        expect(byName(scanned.methods, 'inbound').caller).toEqual({ kind: 'saas', label: 'twilio' });
        expect(scanned.diagnostics.undeclaredExternalCallers()).toEqual([]);
    });

    it('honours an explicit callerKind — a push subscription is infrastructure, not a vendor', () => {
        const scanned = scan(`
@ApiPath('/hooks')
export abstract class HookApi {
    @Endpoint('/push', 'external', { calledBy: 'pubsub-push', callerKind: 'system' })
    abstract push(): Promise<void>;
}`);
        expect(byName(scanned.methods, 'push').caller).toEqual({ kind: 'system', label: 'pubsub-push' });
    });

    it('resolves a SAME-module const, exactly as a path argument does', () => {
        const scanned = scan(`
const TWILIO = 'twilio';
@ApiPath('/hooks')
export abstract class HookApi {
    @Endpoint('/inbound', 'external', { calledBy: TWILIO })
    abstract inbound(): Promise<void>;
}`);
        expect(byName(scanned.methods, 'inbound').caller).toEqual({ kind: 'saas', label: 'twilio' });
    });

    it('records NO caller for a non-external endpoint, even when one is written', () => {
        // Kind-specific exactly like queueName: a caller on an rpc method is a fact about nothing,
        // and would put a vendor box beside an endpoint no vendor calls.
        const scanned = scan(`
@ApiPath('/hooks')
export abstract class HookApi {
    @Endpoint('/rpc', 'rpc', { calledBy: 'twilio' })
    abstract go(): Promise<void>;

    @Endpoint('/task', 'cloudtasks', { calledBy: 'twilio' })
    abstract task(): Promise<void>;
}`);
        expect(byName(scanned.methods, 'go').caller).toBeUndefined();
        expect(byName(scanned.methods, 'task').caller).toBeUndefined();
        expect(scanned.diagnostics.undeclaredExternalCallers()).toEqual([]);
    });
});

describe('an unreadable caller is a FATAL generation diagnostic', () => {
    /** The scan is parser-only, so it sees exactly what a JS caller or an `as any` can smuggle past TS. */
    const cases: [string, string, string][] = [
        ['no options argument at all', `@Endpoint('/a', 'external')`, '<no options argument>'],
        ['options without calledBy', `@Endpoint('/a', 'external', { formPost: true })`, '<no calledBy>'],
        ['a cross-module const', `@Endpoint('/a', 'external', { calledBy: IMPORTED })`, 'IMPORTED'],
        ['an unknown callerKind', `@Endpoint('/a', 'external', { calledBy: 'x', callerKind: 'vendor' })`, "callerKind: 'vendor'"],
        ['a non-literal options bag', `@Endpoint('/a', 'external', OPTIONS)`, 'OPTIONS'],
    ];

    for (const [name, decorator, expected] of cases) {
        it(`names ${name}`, () => {
            const scanned = scan(`
@ApiPath('/hooks')
export abstract class HookApi {
    ${decorator}
    abstract a(): Promise<void>;
}`);
            const found = scanned.diagnostics.undeclaredExternalCallers();
            expect(found).toHaveLength(1);
            expect(found[0].api).toBe('HookApi');
            expect(found[0].method).toBe('a');
            expect(found[0].argument).toBe(expected);
            expect(found[0].at).toContain('libraries/hook-api/src/index.ts:');
            // The METHOD is kept: it is a real route, and dropping it would empty the contract and
            // report the wrong problem.
            expect(byName(scanned.methods, 'a').caller).toBeUndefined();
        });
    }

    it('aggregates every offender into ONE actionable error', () => {
        const error = new UndeclaredExternalCallerError([
            { api: 'WhatsAppApi', method: 'inbound', argument: '<no calledBy>', at: 'libraries/a/src/index.ts:12' },
            { api: 'GmailApi', method: 'watch', argument: 'HOOK_CALLER', at: 'libraries/b/src/index.ts:30' },
        ]);
        expect(error.message).toContain("2 'external' @Endpoint(s) do not declare WHO calls them");
        expect(error.message).toContain('WhatsAppApi.inbound');
        expect(error.message).toContain('GmailApi.watch');
        expect(error.message).toContain("calledBy: 'twilio'");
        expect(error.message).toContain('callerKind');
    });
});

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function service(implementsApis: string[]): RuntimeService {
    return { level: 0, implements: implementsApis, uses: [], dependsOn: [] };
}

/** `ai-chat` implements one contract with two external methods. */
function chatGraph(): EnhancedGraph {
    return {
        'whatsapp-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        'ai-chat': {
            level: 1,
            dependsOn: ['whatsapp-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'whatsapp-api': {
                    kind: 'implements',
                    implements: [{ api: 'WhatsAppApi', type: 'rpc' }],
                    uses: [],
                },
            },
        },
    };
}

function contracts(methods: ApiMethodMeta[]): ApiContracts {
    return { WhatsAppApi: { owner: 'whatsapp-api', apiKind: 'rpc', basePath: '/whatsapp', methods } };
}

/** Every `"<id>" [` node STATEMENT in the dot, so a duplicated node is caught rather than assumed away. */
function nodeStatements(dot: string, id: string): string[] {
    return dot.split('\n').filter((line: string) => line.trim().startsWith(`"${id}" [`));
}

function arrowsFrom(dot: string, id: string): string[] {
    return dot.split('\n').filter((line: string) => line.includes(`"${id}" ->`));
}

describe('drawing the inbound caller', () => {
    it('labels the box with the CALLER and leaves the contract on the edge', () => {
        const dot = generateRuntimeDot(
            deriveRuntimeGraph(chatGraph(), new Set<string>(), contracts([
                { name: 'inbound', path: '/inbound', kind: 'external', caller: { kind: 'saas', label: 'twilio' } },
            ])),
        );
        expect(dot).toContain('label="twilio\\n(external caller)"');
        expect(dot).not.toContain('WhatsAppApi\\n(external caller)');
        expect(dot).toContain('"system__twilio" -> "ai-chat" [label="WhatsAppApi.inbound"');
    });

    it('converges ONE caller on ONE box however many methods it posts to', () => {
        const dot = generateRuntimeDot(
            deriveRuntimeGraph(chatGraph(), new Set<string>(), contracts([
                { name: 'inbound', path: '/in', kind: 'external', caller: { kind: 'saas', label: 'twilio' } },
                { name: 'status', path: '/status', kind: 'external', caller: { kind: 'saas', label: 'twilio' } },
            ])),
        );
        expect(nodeStatements(dot, 'system__twilio')).toHaveLength(1);
        expect(arrowsFrom(dot, 'system__twilio')).toHaveLength(2);
    });

    it('splits TWO callers on one contract into two boxes', () => {
        // The old id was `inbound__${api}`, so two vendors posting to one contract collapsed into a
        // single box labelled with that contract — the diagram asserted they were the same system.
        const dot = generateRuntimeDot(
            deriveRuntimeGraph(chatGraph(), new Set<string>(), contracts([
                { name: 'inbound', path: '/in', kind: 'external', caller: { kind: 'saas', label: 'twilio' } },
                { name: 'watch', path: '/watch', kind: 'external', caller: { kind: 'saas', label: 'gmail' } },
            ])),
        );
        expect(nodeStatements(dot, 'system__twilio')).toHaveLength(1);
        expect(nodeStatements(dot, 'system__gmail')).toHaveLength(1);
        expect(arrowsFrom(dot, 'system__twilio')).toHaveLength(1);
        expect(arrowsFrom(dot, 'system__gmail')).toHaveLength(1);
    });

    it('draws the shape of the caller KIND, not always a box', () => {
        const dot = generateRuntimeDot(
            deriveRuntimeGraph(chatGraph(), new Set<string>(), contracts([
                { name: 'drain', path: '/drain', kind: 'external', caller: { kind: 'queue', label: 'sqs-inbox' } },
            ])),
        );
        expect(dot).toContain('"system__sqs_inbox" [shape=Mrecord');
        expect(dot).toContain('class="wp_queue"');
    });
});

describe('inbound and outbound converge on ONE node for the same vendor', () => {
    /** `ai-chat` is POSTED TO by twilio and also CALLS a twilio seam — the same vendor, both ways. */
    function bothWays(showExternalNodes: boolean = true): string {
        const graph: RuntimeGraph = deriveRuntimeGraph(chatGraph(), new Set<string>(), contracts([
            { name: 'inbound', path: '/in', kind: 'external', caller: { kind: 'saas', label: 'twilio' } },
        ]));
        graph.services['ai-chat'] = service(['WhatsAppApi']);
        attachExternalSystems(graph, {
            twilio: { kind: 'saas', label: 'twilio', usedBy: ['ai-chat'], apis: ['TwilioSendApi'] },
        });
        return generateRuntimeDot(graph, 'T', new RuntimeVizOptions(showExternalNodes));
    }

    it('states the node ONCE, with an arrow in each direction', () => {
        const dot = bothWays();
        // Reusing ExternalSystemDeclaration is what buys this: the same (kind,label) on both halves
        // means one identity, so twilio is one box rather than two facing opposite ways.
        expect(nodeStatements(dot, 'system__twilio')).toHaveLength(1);
        expect(arrowsFrom(dot, 'system__twilio')).toEqual([
            expect.stringContaining('"system__twilio" -> "ai-chat" [label="WhatsAppApi.inbound"'),
        ]);
        expect(dot).toContain('"ai-chat" -> "system__twilio"');
    });

    it('still draws the inbound box when outbound external nodes are turned OFF', () => {
        // showExternalNodes:false suppresses the OUTBOUND half only; an inbound entry point is not
        // vendor noise, it is how the service gets woken up.
        const dot = bothWays(false);
        expect(nodeStatements(dot, 'system__twilio')).toHaveLength(1);
        expect(dot).not.toContain('"ai-chat" -> "system__twilio"');
    });
});
