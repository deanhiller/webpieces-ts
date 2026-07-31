/**
 * The BARE SERVER case: a `role:server` that declares NO apiRelations at all — no contract it
 * implements, no contract it uses, no external declaration. A real one exists (a service whose only
 * work arrives on a pull subscription published by a system outside the repo), and the derivation
 * used to DELETE it: `collectDecls` emitted a decl only when a node had at least one relation, so a
 * deployed service was absent from runtime-dependencies.json with no warning and no problem. The
 * graph looked complete, which is the worst way for it to be wrong.
 *
 * These specs pin the contract that replaced that filter: isNode() is the whole test, and
 * `drawOnGraph:false` is the ONE thing that removes a server from the drawing.
 */

import { describe, it, expect } from 'vitest';
import { deriveRuntimeGraph, deriveRuntimeGraphReport } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import { generateRuntimeDot } from '../runtime-visualizer';
import { checkServersPresent } from '../../executors/validate-runtime-architecture/executor';

/**
 * A server with zero relations, its library dep (also relation-less), plus an api-lib — so the
 * "still not a node" half of the contract is checked against BOTH library roles.
 */
function bareServerGraph(): EnhancedGraph {
    return {
        'shared-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        'lib-util': { level: 0, dependsOn: [], role: 'lib', framework: ['node'] },
        'crm-manager': { level: 1, dependsOn: ['lib-util'], role: 'server', framework: ['node'] },
    };
}

describe('a role:server with no apiRelations at all', () => {
    const derived = deriveRuntimeGraph(bareServerGraph());

    it('IS a node — empty implements/uses/dependsOn, level 0', () => {
        const svc = derived.services['crm-manager'];
        expect(svc).toBeDefined();
        expect(svc.implements).toEqual([]);
        expect(svc.uses).toEqual([]);
        expect(svc.dependsOn).toEqual([]);
        expect(svc.level).toBe(0);
    });

    it('carries its DECLARED role, so nothing has to infer it from implements', () => {
        expect(derived.services['crm-manager'].role).toBe('server');
    });

    it('does NOT turn libraries into nodes (role:lib / role:api-lib are still excluded)', () => {
        expect(derived.services['lib-util']).toBeUndefined();
        expect(derived.services['shared-api']).toBeUndefined();
    });

    it('produces no apis, edges, queues, triggers or unresolved uses, and no warnings/problems', () => {
        const report = deriveRuntimeGraphReport(bareServerGraph());
        expect(derived.apis).toEqual({});
        expect(derived.runtimeEdges).toEqual([]);
        expect(derived.queues).toEqual({});
        expect(derived.triggers).toEqual([]);
        expect(derived.unresolvedUses).toEqual([]);
        expect(report.warnings).toEqual([]);
        expect(report.problems).toEqual([]);
    });

    it('renders as an ISOLATED node in the DOT — drawn, with no arrow touching it', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).toContain('"crm-manager"');
        expect(dot).not.toContain('->');
    });

    it('is labelled (server, L0) rather than the old implements-inferred "client"', () => {
        expect(generateRuntimeDot(derived)).toContain('crm-manager\\n(server, L0)');
    });

    it('is removed from the DOT by drawOnGraph:false — and by nothing else', () => {
        const hidden = deriveRuntimeGraph(bareServerGraph(), new Set<string>(['crm-manager']));
        expect(hidden.services['crm-manager'].drawOnGraph).toBe(false);
        expect(generateRuntimeDot(hidden)).not.toContain('"crm-manager"');
    });
});

describe('checkServersPresent — every role:server reached the graph', () => {
    const projects = bareServerGraph();

    it('passes when every server has a node', () => {
        const graph = deriveRuntimeGraph(projects);
        expect(checkServersPresent(projects, new Set<string>(), graph)).toEqual([]);
    });

    it('fails, naming the service, when a server has no node', () => {
        const graph = deriveRuntimeGraph(projects);
        delete graph.services['crm-manager'];
        const problems = checkServersPresent(projects, new Set<string>(), graph);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("role:server 'crm-manager' has no node in the runtime graph");
        expect(problems[0]).toContain('drawOnGraph:false');
    });

    it('passes when the missing server is deliberately drawOnGraph:false', () => {
        const graph = deriveRuntimeGraph(projects);
        delete graph.services['crm-manager'];
        expect(checkServersPresent(projects, new Set<string>(['crm-manager']), graph)).toEqual([]);
    });

    it('says nothing about libraries — only role:server is checked', () => {
        const graph = deriveRuntimeGraph(projects);
        delete graph.services['crm-manager'];
        const problems = checkServersPresent(projects, new Set<string>(['crm-manager']), graph);
        expect(problems.join('\n')).not.toContain('lib-util');
    });
});
