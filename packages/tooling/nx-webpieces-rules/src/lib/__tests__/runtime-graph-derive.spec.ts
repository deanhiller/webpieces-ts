/**
 * Tests the runtime graph DERIVED from dependencies.json (per-project apiRelations): an rpc API
 * becomes a direct runtime edge; a pubsub API becomes an edge drawn producer -> queue -> consumer.
 * Both architecture:generate and architecture:validate-runtime-architecture call deriveRuntimeGraph
 * over the SAME EnhancedGraph, so they can never diverge.
 */

import { describe, it, expect } from 'vitest';
import {
    deriveRuntimeGraph,
    deriveRuntimeGraphReport,
    serializeRuntimeGraph,
} from '../runtime-graph';
import type { RuntimeEdge } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import type { ApiRef } from '../api-usage/api-relations';
import { generateRuntimeDot, RuntimeVizOptions } from '../runtime-visualizer';

/**
 * An EnhancedGraph like the one dependencies.json holds: `producer` uses two APIs owned by the
 * `shared-api` api-lib; `consumer` implements both. Transport comes from each ApiRef's `type`.
 */
function graph(): EnhancedGraph {
    return {
        'shared-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        producer: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'shared-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [
                        { api: 'EmailApi', type: 'pubsub' },
                        { api: 'RpcApi', type: 'rpc' },
                    ],
                },
            },
        },
        consumer: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'shared-api': {
                    kind: 'implements',
                    implements: [
                        { api: 'EmailApi', type: 'pubsub' },
                        { api: 'RpcApi', type: 'rpc' },
                    ],
                    uses: [],
                },
            },
        },
    };
}

describe('deriveRuntimeGraph', () => {
    const derived = deriveRuntimeGraph(graph());

    it('records each API by CLASS name with its transport', () => {
        expect(derived.apis['EmailApi'].type).toBe('pubsub');
        expect(derived.apis['EmailApi'].implementedBy).toEqual(['consumer']);
        expect(derived.apis['EmailApi'].usedBy).toEqual(['producer']);
        expect(derived.apis['RpcApi'].type).toBe('rpc');
    });

    it('splits producer→consumer into one rpc edge and one pubsub edge', () => {
        const edges = derived.runtimeEdges.filter((e: RuntimeEdge) => e.from === 'producer' && e.to === 'consumer');
        expect(edges).toHaveLength(2);
        const rpc = edges.find((e: RuntimeEdge) => e.type === 'rpc');
        const pubsub = edges.find((e: RuntimeEdge) => e.type === 'pubsub');
        expect(rpc?.via).toEqual(['RpcApi']);
        expect(pubsub?.via).toEqual(['EmailApi']);
    });

    it('records service implements/uses at api-class granularity', () => {
        expect(derived.services['producer'].uses.sort()).toEqual(['EmailApi', 'RpcApi']);
        expect(derived.services['consumer'].implements.sort()).toEqual(['EmailApi', 'RpcApi']);
    });

    it('ignores projects with no apiRelations (the api-lib itself is not a runtime node)', () => {
        expect(derived.services['shared-api']).toBeUndefined();
    });
});

/**
 * A shared client-factory LIB (role:lib) calls createRpcClient(AuthApi); two apps embed it. The lib
 * must NOT be a runtime node — its `uses` is attributed to the server + client that depend on it.
 */
function graphWithSharedLib(): EnhancedGraph {
    return {
        'auth-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        'auth-server': {
            level: 2,
            dependsOn: ['auth-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'auth-api': { kind: 'implements', implements: [{ api: 'AuthApi', type: 'rpc' }], uses: [] },
            },
        },
        'auth-client-lib': {
            level: 1,
            dependsOn: ['auth-api'],
            role: 'lib',
            framework: ['browser', 'node'],
            apiRelations: {
                'auth-api': { kind: 'uses', implements: [], uses: [{ api: 'AuthApi', type: 'rpc' }] },
            },
        },
        'app-web': { level: 2, dependsOn: ['auth-client-lib'], role: 'client', framework: ['browser'] },
        'app-svr': { level: 2, dependsOn: ['auth-client-lib'], role: 'server', framework: ['node'] },
    };
}

describe('a lib that calls createRpcClient is not a node — its use propagates to the embedding apps', () => {
    const derived = deriveRuntimeGraph(graphWithSharedLib());

    it('does not make the shared lib (or the api-lib) a runtime node', () => {
        expect(derived.services['auth-client-lib']).toBeUndefined();
        expect(derived.services['auth-api']).toBeUndefined();
    });

    it('attributes the lib’s AuthApi use to BOTH embedding apps (server + client)', () => {
        expect(derived.services['app-web'].uses).toEqual(['AuthApi']);
        expect(derived.services['app-svr'].uses).toEqual(['AuthApi']);
        expect(derived.apis['AuthApi'].usedBy).toEqual(['app-svr', 'app-web']);
        expect(derived.apis['AuthApi'].implementedBy).toEqual(['auth-server']);
    });

    it('draws the runtime edges from the apps to the implementing server (not from the lib)', () => {
        const froms = derived.runtimeEdges.map((e: RuntimeEdge) => `${e.from}->${e.to}`).sort();
        expect(froms).toEqual(['app-svr->auth-server', 'app-web->auth-server']);
    });
});

describe('generate and validate derive the SAME graph from dependencies.json', () => {
    it('is byte-identical when derived from the graph vs a JSON round-trip of it (what validate loads)', () => {
        const fromMemory = deriveRuntimeGraph(graph());
        // Mimic validate: it loads the committed dependencies.json (a JSON round-trip of the graph).
        const roundTripped = JSON.parse(JSON.stringify(graph())) as EnhancedGraph;
        const fromDisk = deriveRuntimeGraph(roundTripped);
        expect(serializeRuntimeGraph(fromDisk)).toBe(serializeRuntimeGraph(fromMemory));
    });
});

describe('drawOnGraph:false hides a service from the runtime render but keeps it in the JSON', () => {
    const derived = deriveRuntimeGraph(graph(), new Set(['consumer']));

    it('flags the hidden service in the graph data (kept, not dropped)', () => {
        expect(derived.services['consumer'].drawOnGraph).toBe(false);
        expect(derived.services['producer'].drawOnGraph).toBeUndefined();
    });

    it('omits the hidden node and every edge/queue touching it from the DOT', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).not.toContain('"consumer" [');
        expect(dot).not.toContain('-> "consumer"');
        expect(dot).not.toContain('queue__producer__consumer');
        expect(dot).toContain('"producer" [');
    });
});

/**
 * The shape that used to produce fiction: `WarmupApi` is registered ONCE in a shared library, so
 * the transitive attribution (correctly) lands it on EVERY server. Every user of it therefore got
 * an edge to every server in the repo — including a browser bundle to another product's data
 * server, and a false helper-svr <-> lang cycle that failed the build.
 *
 * Each call site names its target (`new ClientConfig('helper-fsdb')`), captured as
 * `ApiRef.targetService` and matched against the DECLARED `serviceName`. Note the naming spaces do
 * not line up: helper-svr is called 'helper-portal'; no suffix rule could derive that.
 */
function companyWideApiGraph(): EnhancedGraph {
    const warmup = { api: 'WarmupApi', type: 'rpc' as const };
    return {
        'warmup-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['browser', 'node'] },
        'fsdb-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['browser', 'node'] },
        // The shared lib every server embeds — the single registration of the company-wide contract.
        'svc-core': {
            level: 1,
            dependsOn: ['warmup-api'],
            role: 'lib',
            framework: ['node'],
            apiRelations: { 'warmup-api': { kind: 'implements', implements: [warmup], uses: [] } },
        },
        'helper-fsdb-svr': {
            level: 2,
            dependsOn: ['svc-core', 'fsdb-api'],
            role: 'server',
            framework: ['node'],
            serviceName: 'helper-fsdb',
            apiRelations: {
                'fsdb-api': { kind: 'implements', implements: [{ api: 'HelperFsdbApi', type: 'rpc' }], uses: [] },
            },
        },
        'lang-fsdb-svr': {
            level: 2,
            dependsOn: ['svc-core', 'fsdb-api'],
            role: 'server',
            framework: ['node'],
            serviceName: 'lang-fsdb',
            apiRelations: {
                'fsdb-api': { kind: 'implements', implements: [{ api: 'LangFsdbApi', type: 'rpc' }], uses: [] },
            },
        },
        'helper-svr': {
            level: 3,
            dependsOn: ['svc-core', 'fsdb-api', 'warmup-api'],
            role: 'server',
            framework: ['node'],
            serviceName: 'helper-portal',
            apiRelations: {
                'fsdb-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [{ api: 'HelperFsdbApi', type: 'rpc', targetService: 'helper-fsdb' }],
                },
                'warmup-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [{ api: 'WarmupApi', type: 'rpc', targetService: 'helper-fsdb' }],
                },
            },
        },
        'helper-portal-angular': {
            level: 3,
            dependsOn: ['warmup-api'],
            role: 'client',
            framework: ['angular', 'browser'],
            apiRelations: {
                'warmup-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [{ api: 'WarmupApi', type: 'rpc', targetService: 'helper-portal' }],
                },
            },
        },
    };
}

/** The same graph with the client configs unreadable — the pre-fix behavior, now reported. */
function untargetedGraph(): EnhancedGraph {
    const graph = companyWideApiGraph();
    for (const project of ['helper-svr', 'helper-portal-angular']) {
        const relations = graph[project].apiRelations!;
        for (const owner of Object.keys(relations)) {
            relations[owner].uses = relations[owner].uses.map((ref: ApiRef) => ({ api: ref.api, type: ref.type }));
        }
    }
    return graph;
}

describe('a targeted client call produces ONE edge, not one per implementer', () => {
    const report = deriveRuntimeGraphReport(companyWideApiGraph());
    const edges = report.graph.runtimeEdges.map((e: RuntimeEdge) => `${e.from}->${e.to}`).sort();

    it('attributes the shared library’s implements to every server (the input to the bug)', () => {
        expect(report.graph.apis['WarmupApi'].implementedBy).toEqual([
            'helper-fsdb-svr',
            'helper-svr',
            'lang-fsdb-svr',
        ]);
    });

    it('draws the browser edge ONLY to the server it names, not to every implementer', () => {
        expect(edges.filter((e: string) => e.startsWith('helper-portal-angular->'))).toEqual([
            'helper-portal-angular->helper-svr',
        ]);
    });

    it('does not manufacture the cross-product edges (no other product’s data server)', () => {
        expect(edges).not.toContain('helper-portal-angular->lang-fsdb-svr');
        expect(edges).not.toContain('helper-svr->lang-fsdb-svr');
    });

    it('lets an app server warm its OWN data server without inventing a cycle', () => {
        expect(edges.filter((e: string) => e.startsWith('helper-svr->'))).toEqual(['helper-svr->helper-fsdb-svr']);
        const warmupEdge = report.graph.runtimeEdges.find(
            (e: RuntimeEdge) => e.from === 'helper-svr' && e.to === 'helper-fsdb-svr',
        );
        expect(warmupEdge?.via).toEqual(['HelperFsdbApi', 'WarmupApi']);
    });

    it('says nothing when every call site resolved — warnings are for guesses only', () => {
        expect(report.warnings).toEqual([]);
    });

    it('records the declared service name on the node', () => {
        expect(report.graph.services['helper-svr'].serviceName).toBe('helper-portal');
        expect(report.graph.services['helper-portal-angular'].serviceName).toBeUndefined();
    });
});

describe('an unresolvable target degrades to fan-out, but LOUDLY', () => {
    it('fans out and names each ambiguous call site when no client config literal was found', () => {
        const report = deriveRuntimeGraphReport(untargetedGraph());
        const edges = report.graph.runtimeEdges.map((e: RuntimeEdge) => `${e.from}->${e.to}`);
        // The old, wrong behavior is preserved as the safe superset...
        expect(edges).toContain('helper-portal-angular->lang-fsdb-svr');
        // ...but it can no longer pass for a derived fact.
        expect(report.warnings.some((w: string) => w.includes('helper-portal-angular') && w.includes('WarmupApi'))).toBe(
            true,
        );
    });

    it('FAILS when the named service matches no module and no declared alias', () => {
        const graph = companyWideApiGraph();
        graph['helper-portal-angular'].apiRelations!['warmup-api'].uses = [
            { api: 'WarmupApi', type: 'rpc', targetService: 'typo-portal' },
        ];
        const report = deriveRuntimeGraphReport(graph);
        expect(report.problems.some((p: string) => p.includes("'typo-portal'"))).toBe(true);
        // Still derives a graph — validate fails the build, generate must keep writing the file.
        expect(report.graph.runtimeEdges.some((e: RuntimeEdge) => e.from === 'helper-portal-angular')).toBe(true);
    });

    it('FAILS when the named service exists but does not serve the contract', () => {
        const graph = companyWideApiGraph();
        graph['helper-svr'].apiRelations!['fsdb-api'].uses = [
            { api: 'HelperFsdbApi', type: 'rpc', targetService: 'lang-fsdb' },
        ];
        const report = deriveRuntimeGraphReport(graph);
        expect(report.problems.some((p: string) => p.includes('does NOT') && p.includes('HelperFsdbApi'))).toBe(true);
    });

});

/**
 * The shared-library case #475 could not resolve: the client is built once in a shared lib from a
 * config field, so no literal `ClientConfig` sits at the call site — it lives one indirection away in
 * the app. The CALLING project declares its target with metadata.webpieces.callsService, the
 * symmetric half of the implementing side's serviceName.
 */
describe('a client-project callsService declaration resolves an untargeted use to ONE edge', () => {
    /** untargetedGraph() has NO literals; declaring callsService on the browser client is the fix. */
    function withCallsService(value: string | Record<string, string>): EnhancedGraph {
        const graph = untargetedGraph();
        graph['helper-portal-angular'].callsService = value;
        return graph;
    }

    it('produces exactly one edge per used api, to the declared service, with no warning (check 1)', () => {
        const report = deriveRuntimeGraphReport(withCallsService('helper-portal'));
        const edges = report.graph.runtimeEdges
            .filter((e: RuntimeEdge) => e.from === 'helper-portal-angular')
            .map((e: RuntimeEdge) => `${e.from}->${e.to}`);
        expect(edges).toEqual(['helper-portal-angular->helper-svr']);
        // No warning for the client whose target is now declared (helper-svr, still untargeted, is
        // a separate matter). And nothing FAILS the build.
        expect(report.warnings.some((w: string) => w.includes('helper-portal-angular'))).toBe(false);
        expect(report.problems).toEqual([]);
    });

    it('records the declared callsService on the node', () => {
        const report = deriveRuntimeGraphReport(withCallsService('helper-portal'));
        expect(report.graph.services['helper-portal-angular'].callsService).toBe('helper-portal');
    });

    it('lets a literal ClientConfig at the call site still WIN over the project declaration (check 2)', () => {
        // companyWideApiGraph keeps the literal targetService 'helper-portal'; point callsService at a
        // DIFFERENT (wrong) service. The literal must win, so the edge and lack of problems are unchanged.
        const graph = companyWideApiGraph();
        graph['helper-portal-angular'].callsService = 'lang-fsdb';
        const report = deriveRuntimeGraphReport(graph);
        expect(report.problems).toEqual([]);
        expect(
            report.graph.runtimeEdges
                .filter((e: RuntimeEdge) => e.from === 'helper-portal-angular')
                .map((e: RuntimeEdge) => e.to),
        ).toEqual(['helper-svr']);
    });

    it('still fans out AND warns when a client declares neither literal nor callsService (check 3)', () => {
        const report = deriveRuntimeGraphReport(untargetedGraph());
        expect(
            report.graph.runtimeEdges.some(
                (e: RuntimeEdge) => e.from === 'helper-portal-angular' && e.to === 'lang-fsdb-svr',
            ),
        ).toBe(true);
        expect(report.warnings.some((w: string) => w.includes('helper-portal-angular') && w.includes('WarmupApi'))).toBe(
            true,
        );
    });

    it('FAILS the build when callsService names a service that does not serve the api (check 4)', () => {
        // helper-svr uses HelperFsdbApi (served ONLY by helper-fsdb-svr). Aim its callsService at
        // lang-fsdb, which serves LangFsdbApi — so the HelperFsdbApi call has nothing to answer it.
        const graph = untargetedGraph();
        graph['helper-svr'].callsService = 'lang-fsdb';
        const report = deriveRuntimeGraphReport(graph);
        expect(report.problems.some((p: string) => p.includes('does NOT serve') && p.includes('HelperFsdbApi'))).toBe(
            true,
        );
    });

    it('FAILS the build when callsService names a service no module answers to', () => {
        const report = deriveRuntimeGraphReport(withCallsService('typo-portal'));
        expect(
            report.problems.some((p: string) => p.includes('callsService') && p.includes("'typo-portal'")),
        ).toBe(true);
    });

});

describe('a callsService MAP resolves per api-class for a client that calls several services', () => {
    function withCallsService(value: Record<string, string>): EnhancedGraph {
        const graph = untargetedGraph();
        graph['helper-portal-angular'].callsService = value;
        return graph;
    }

    it('resolves the listed api-class to its declared service', () => {
        // helper-portal-angular only uses WarmupApi here; map it explicitly, leave others unlisted.
        const report = deriveRuntimeGraphReport(withCallsService({ WarmupApi: 'helper-portal' }));
        expect(report.problems).toEqual([]);
        expect(
            report.graph.runtimeEdges
                .filter((e: RuntimeEdge) => e.from === 'helper-portal-angular')
                .map((e: RuntimeEdge) => e.to),
        ).toEqual(['helper-svr']);
    });

    it('falls back to fan-out+warn for an api the map does not list', () => {
        // Map lists only AuthApi (not used here), so WarmupApi stays unresolved -> fan-out + warning.
        const report = deriveRuntimeGraphReport(withCallsService({ AuthApi: 'auth' }));
        expect(report.warnings.some((w: string) => w.includes('helper-portal-angular') && w.includes('WarmupApi'))).toBe(
            true,
        );
    });
});

/**
 * A target resolves against the MODULE name always, plus a declared `serviceName` alias. Both
 * adoption paths must work: monorepo-nx3 addresses `tf-ai-chat` for the `ai-chat` module, so it can
 * either declare the prefixed name as an alias, or write the module name and let ClientRegistry's
 * deriver add the prefix at runtime.
 */
describe('what a target service name may resolve to', () => {
    it('resolves a target by MODULE name with no declaration at all', () => {
        const graph = companyWideApiGraph();
        graph['helper-portal-angular'].apiRelations!['warmup-api'].uses = [
            { api: 'WarmupApi', type: 'rpc', targetService: 'helper-svr' },
        ];
        const report = deriveRuntimeGraphReport(graph);
        expect(report.problems).toEqual([]);
        expect(report.graph.runtimeEdges.filter((e: RuntimeEdge) => e.from === 'helper-portal-angular')).toHaveLength(1);
    });

    it('resolves a target by declared alias when the deployed name differs from the module', () => {
        // 'helper-portal' is not a module — only the alias on helper-svr makes it addressable.
        const report = deriveRuntimeGraphReport(companyWideApiGraph());
        expect(report.problems).toEqual([]);
        expect(report.graph.runtimeEdges.some((e: RuntimeEdge) => e.to === 'helper-svr')).toBe(true);
    });

    it('never lets an alias shadow a real module, and reports the unreachable alias', () => {
        const graph = companyWideApiGraph();
        // lang-fsdb-svr claims the NAME of a sibling module as its alias...
        graph['lang-fsdb-svr'].serviceName = 'helper-fsdb-svr';
        graph['helper-svr'].apiRelations!['fsdb-api'].uses = [
            { api: 'HelperFsdbApi', type: 'rpc', targetService: 'helper-fsdb-svr' },
        ];
        const report = deriveRuntimeGraphReport(graph);
        // ...the module name still wins, so the call lands where the contract is actually served.
        expect(report.graph.runtimeEdges.some((e: RuntimeEdge) => e.to === 'helper-fsdb-svr')).toBe(true);
        expect(report.graph.runtimeEdges.some((e: RuntimeEdge) => e.to === 'lang-fsdb-svr')).toBe(false);
        expect(report.problems.some((p: string) => p.includes('can never be reached'))).toBe(true);
    });

    it('stays silent for an untargeted use with exactly ONE implementer (nothing to guess)', () => {
        expect(deriveRuntimeGraphReport(graphWithSharedLib()).warnings).toEqual([]);
    });
});

describe('the runtime node says what it implements and where that came from', () => {
    const derived = deriveRuntimeGraph(companyWideApiGraph());

    it('records the library a contract is served through, not just that it is served', () => {
        expect(derived.services['helper-svr'].implementsVia).toEqual({ WarmupApi: 'svc-core' });
        expect(derived.services['helper-fsdb-svr'].implementsVia).toEqual({ WarmupApi: 'svc-core' });
        // A contract from the server's OWN source has no "via" — it is not indirection.
        expect(derived.services['helper-fsdb-svr'].implements).toContain('HelperFsdbApi');
    });

    it('names the implemented + used contracts ON the node, with no incoming edge needed', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).toContain('implements: HelperFsdbApi, WarmupApi (via svc-core)');
        expect(dot).toContain('uses: HelperFsdbApi, WarmupApi');
        // The declared runtime name is on the node too, so the ClientConfig string is discoverable.
        // The quotes around it are ESCAPED — a bare `"` here ends the label and kills the graph.
        expect(dot).toContain(', \\"helper-portal\\")');
    });

    it('keeps a service name containing DOT-special characters from breaking the graph', () => {
        const withQuote = deriveRuntimeGraph(companyWideApiGraph());
        withQuote.services['helper-svr'].serviceName = 'odd"name\\path';
        const dot = generateRuntimeDot(withQuote);
        // Escaped, not merely assumed harmless — and generateRuntimeDot parse-checks what it emits.
        expect(dot).toContain('odd\\"name\\\\path');
    });

    it('shows an api that a server serves and NOTHING in-repo calls', () => {
        const dot = generateRuntimeDot(derived);
        expect(derived.apis['LangFsdbApi'].usedBy).toEqual([]);
        expect(dot).toContain('LangFsdbApi');
    });
});

/** A data server whose calls LEAVE the repo: nothing in-repo implements the firestore contracts. */
function externalCallGraph(): EnhancedGraph {
    return {
        'lib-firestore': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        'fsdb-svr': {
            level: 1,
            dependsOn: ['lib-firestore'],
            role: 'server',
            framework: ['node'],
            serviceName: 'helper-fsdb',
            apiRelations: {
                'lib-firestore': {
                    kind: 'uses',
                    implements: [],
                    uses: [
                        { api: 'FirestoreReadApi', type: 'rpc' },
                        { api: 'FirestoreWriteApi', type: 'rpc' },
                    ],
                },
            },
        },
    };
}

describe('external systems are drawn as terminal nodes (render-only)', () => {
    const derived = deriveRuntimeGraph(externalCallGraph());

    it('leaves unresolvedUses exactly as before — this CONSUMES that data, it does not redefine it', () => {
        expect(derived.unresolvedUses).toEqual([
            { service: 'fsdb-svr', api: 'FirestoreReadApi' },
            { service: 'fsdb-svr', api: 'FirestoreWriteApi' },
        ]);
    });

    it('draws ONE dashed box per external library, labeled with the contracts flowing to it', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).toContain('"external__lib-firestore" [shape=box, style="dashed,filled"');
        expect(dot).toContain('(external)"');
        expect(dot).toContain('"fsdb-svr" -> "external__lib-firestore" [label="FirestoreReadApi, FirestoreWriteApi"');
    });

    it('keeps them OUT of the graph data — no service, no level, no cycle input', () => {
        expect(derived.services['lib-firestore']).toBeUndefined();
        expect(derived.runtimeEdges).toEqual([]);
    });

    it('can be switched off for a repo with a noisy external surface', () => {
        const dot = generateRuntimeDot(derived, 'title', new RuntimeVizOptions(false));
        expect(dot).not.toContain('external__');
    });

    it('omits an external node whose only caller is hidden', () => {
        const hidden = deriveRuntimeGraph(externalCallGraph(), new Set(['fsdb-svr']));
        expect(generateRuntimeDot(hidden)).not.toContain('external__');
    });
});

describe('generateRuntimeDot — rpc direct, pubsub via queue', () => {
    const dot = generateRuntimeDot(deriveRuntimeGraph(graph()));

    it('draws the rpc edge as a direct labeled arrow', () => {
        expect(dot).toContain('"producer" -> "consumer" [label="RpcApi"];');
    });

    it('draws the pubsub edge through a cylinder queue node', () => {
        expect(dot).toContain('"queue__producer__consumer" [shape=cylinder');
        expect(dot).toContain('"producer" -> "queue__producer__consumer" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__producer__consumer" -> "consumer" [label="deliver", style=dashed];');
    });
});
