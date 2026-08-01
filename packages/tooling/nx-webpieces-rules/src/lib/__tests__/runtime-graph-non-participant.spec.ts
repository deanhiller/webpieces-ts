/**
 * The NON-PARTICIPANT case: a `role:server` in the monorepo that speaks none of the webpieces
 * runtime — a legacy Express/NestJS service. The runtime graph is built entirely out of webpieces
 * contracts, so such a service can only ever draw as a disconnected box; it has no edges by
 * construction and never will.
 *
 * These specs pin BOTH halves of the contract:
 *  - it is omitted from the DRAWING (drawOnGraph:false, absent from the DOT), and
 *  - it is still a NODE in runtime-dependencies.json with role:'server', so this is a hide and not
 *    the silent deletion #542 removed. checkServersPresent must stay green on it.
 *
 * The shape modelled here is real (monorepo-nx2): eight NestJS integrations with no webpieces
 * package at all, alongside crm-manager which declares none ITSELF but gets http-routing from a
 * shared bootstrap library — the case that makes the closure walk load-bearing.
 */

import { describe, it, expect } from 'vitest';
import { deriveRuntimeGraph, deriveRuntimeGraphReport } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import { generateRuntimeDot } from '../runtime-visualizer';
import { checkServersPresent } from '../../executors/validate-runtime-architecture/executor';

/**
 * `ai-chat` is the participant that makes `markersKnown` true — without at least one project
 * carrying webpiecesRuntime, the whole feature is off and nothing hides (see the back-compat spec
 * at the bottom, and runtime-graph-bare-server.spec.ts).
 */
function mixedRepoGraph(): EnhancedGraph {
    return {
        'svc-core': {
            level: 0,
            dependsOn: [],
            role: 'lib',
            webpiecesRuntime: ['@webpieces/http-routing', '@webpieces/http-server'],
        },
        'lib-bootstrap': { level: 0, dependsOn: ['svc-core'], role: 'lib' },
        'platform-sdk': { level: 0, dependsOn: [], role: 'lib' },
        'ai-chat': {
            level: 0,
            dependsOn: [],
            role: 'server',
            webpiecesRuntime: ['@webpieces/http-routing'],
        },
        // Declares NO marker itself; gets the whole stack from svc-core. The crm-manager shape.
        'crm-manager': { level: 0, dependsOn: ['svc-core'], role: 'server' },
        // Same, one hop further out — pins that the walk is transitive, not just one level deep.
        'two-hop': { level: 0, dependsOn: ['lib-bootstrap'], role: 'server' },
        // The legacy NestJS integration: no markers anywhere in its closure, no relations.
        'orders-manager': { level: 0, dependsOn: ['platform-sdk'], role: 'server' },
    };
}

describe('a role:server that speaks no webpieces runtime package', () => {
    const report = deriveRuntimeGraphReport(mixedRepoGraph());
    const derived = report.graph;

    it('is STILL a node in the JSON, carrying role:server', () => {
        expect(derived.services['orders-manager']).toBeDefined();
        expect(derived.services['orders-manager'].role).toBe('server');
    });

    it('is flagged drawOnGraph:false and omitted from the DOT', () => {
        expect(derived.services['orders-manager'].drawOnGraph).toBe(false);
        expect(generateRuntimeDot(derived)).not.toContain('"orders-manager"');
    });

    it('is reported in autoHidden, so the omission is never silent', () => {
        expect(report.autoHidden).toEqual(['orders-manager']);
    });

    it('keeps checkServersPresent green — the node is present, only the drawing dropped it', () => {
        expect(checkServersPresent(mixedRepoGraph(), new Set<string>(), derived)).toEqual([]);
    });

    it('is neither a warning nor a problem', () => {
        expect(report.warnings).toEqual([]);
        expect(report.problems).toEqual([]);
    });
});

describe('servers that DO participate are drawn', () => {
    const report = deriveRuntimeGraphReport(mixedRepoGraph());
    const dot = generateRuntimeDot(report.graph);

    it('draws one that declares a marker itself', () => {
        expect(report.graph['services']['ai-chat'].drawOnGraph).toBeUndefined();
        expect(dot).toContain('"ai-chat"');
    });

    it('draws one whose only marker comes from a library it depends on (crm-manager)', () => {
        expect(report.graph.services['crm-manager'].drawOnGraph).toBeUndefined();
        expect(dot).toContain('"crm-manager"');
    });

    it('draws one two library hops from the marker — the walk is transitive', () => {
        expect(report.graph.services['two-hop'].drawOnGraph).toBeUndefined();
        expect(dot).toContain('"two-hop"');
    });

    it('lists only the non-participant as auto-hidden', () => {
        expect(report.autoHidden).toEqual(['orders-manager']);
    });
});

describe('participation by contract rather than by package', () => {
    it('draws a marker-less server that USES an in-repo contract', () => {
        const projects = mixedRepoGraph();
        projects['orders-manager'] = {
            level: 0,
            dependsOn: ['shared-api'],
            role: 'server',
            apiRelations: {
                'shared-api': { implements: [], uses: [{ api: 'SomeApi', transport: 'rpc' }] },
            },
        };
        projects['shared-api'] = { level: 0, dependsOn: [], role: 'api-lib' };
        const report = deriveRuntimeGraphReport(projects);
        expect(report.graph.services['orders-manager'].drawOnGraph).toBeUndefined();
        expect(report.autoHidden).toEqual([]);
    });

    it('draws a marker-less server that IMPLEMENTS an in-repo contract', () => {
        const projects = mixedRepoGraph();
        projects['orders-manager'] = {
            level: 0,
            dependsOn: ['shared-api'],
            role: 'server',
            apiRelations: {
                'shared-api': { implements: [{ api: 'SomeApi', transport: 'rpc' }], uses: [] },
            },
        };
        projects['shared-api'] = { level: 0, dependsOn: [], role: 'api-lib' };
        const report = deriveRuntimeGraphReport(projects);
        expect(report.graph.services['orders-manager'].drawOnGraph).toBeUndefined();
        expect(report.autoHidden).toEqual([]);
    });
});

describe('what auto-hiding deliberately does NOT touch', () => {
    it('never auto-hides a role:client, however little it declares', () => {
        const projects = mixedRepoGraph();
        projects['admin-ui'] = { level: 0, dependsOn: [], role: 'client' };
        const report = deriveRuntimeGraphReport(projects);
        expect(report.graph.services['admin-ui'].drawOnGraph).toBeUndefined();
        expect(report.autoHidden).not.toContain('admin-ui');
        expect(generateRuntimeDot(report.graph)).toContain('"admin-ui"');
    });

    it('does not report an explicitly drawOnGraph:false participant as auto-hidden', () => {
        const report = deriveRuntimeGraphReport(mixedRepoGraph(), new Set<string>(['ai-chat']));
        expect(report.graph.services['ai-chat'].drawOnGraph).toBe(false);
        expect(report.autoHidden).toEqual(['orders-manager']);
    });

    it('does not turn the marker-carrying LIBRARY into a node', () => {
        const derived = deriveRuntimeGraph(mixedRepoGraph());
        expect(derived.services['svc-core']).toBeUndefined();
    });
});

describe('back-compat: a graph written before webpiecesRuntime existed', () => {
    /** The same repo with every webpiecesRuntime field stripped — an older dependencies.json. */
    function legacyFileGraph(): EnhancedGraph {
        const projects = mixedRepoGraph();
        for (const name of Object.keys(projects)) delete projects[name].webpiecesRuntime;
        return projects;
    }

    it('hides nothing at all — absence of the field is UNKNOWN, not "declares none"', () => {
        const report = deriveRuntimeGraphReport(legacyFileGraph());
        expect(report.autoHidden).toEqual([]);
        for (const name of Object.keys(report.graph.services))
            expect(report.graph.services[name].drawOnGraph).toBeUndefined();
    });

    it('still draws the legacy server, exactly as it did before this change', () => {
        expect(generateRuntimeDot(deriveRuntimeGraph(legacyFileGraph()))).toContain(
            '"orders-manager"',
        );
    });
});
