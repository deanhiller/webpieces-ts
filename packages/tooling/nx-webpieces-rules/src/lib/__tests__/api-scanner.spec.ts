/**
 * Checks approved wiring topology and build-only contract discovery over the real example apps. This is an integration test over actual
 * source, so it doubles as the contract for the arch `apiRelations` field.
 */

import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApprovedWiringGraph } from '../runtime-wiring/approved-graph';
import { loadBlessedGraph } from '../graph-loader';
import { ProjectApiRelations } from '../api-usage/api-relations';
import { ApiUsageScanner, buildApiContracts } from '../api-usage/api-scanner';
import { ApiMethodMeta, ApiRelation } from '../api-usage/api-relations';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../../..');

function exampleProjects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    const add = (name: string, root: string, tags: string[]): void => {
        infos.set(name, new ProjectInfo(name, root, tags));
    };
    add('client-server', 'apps/app-example/client-server', [
        'webpieces',
        'framework:express',
        'role:server',
    ]);
    add('client-server-api', 'apps/app-example/client-server-api', [
        'framework:browser',
        'framework:node',
        'role:lib',
    ]);
    add('server2', 'apps/app-example/server2', ['webpieces', 'framework:express', 'role:server']);
    add('server2-api', 'apps/app-example/server2-api', [
        'framework:browser',
        'framework:node',
        'role:lib',
    ]);
    add('angular-site', 'apps/app-example/angular-site', [
        'webpieces',
        'framework:angular',
        'role:client',
    ]);
    // Legacy now has a configured app build. The e2e project has only test source.
    add('legacy-server', 'apps/app-example/legacy-server', [
        'webpieces',
        'framework:express',
        'role:server',
    ]);
    add('app-example-e2e', 'apps/app-example/e2e', ['framework:express', 'role:server']);
    // A library owner whose canonical wiring.ts exports the CompanyAuthBindModule the servers select.
    add('company-svc-core', 'apps/app-example/company-svc-core', ['webpieces-lib', 'framework:express', 'role:lib']);
    return infos;
}

function approvedExampleRelations(): Map<string, ProjectApiRelations> {
    const graph = loadBlessedGraph(WORKSPACE_ROOT)!.projects;
    // Erase saved relationships so assertions must come from reviewed declarations.
    for (const entry of Object.values(graph)) delete entry.apiRelations;
    new ApprovedWiringGraph().attach(WORKSPACE_ROOT, graph, exampleProjects());
    return new Map(Object.entries(graph).map(([name, entry]) => [name, entry.apiRelations ?? {}]));
}

function apiNames(refs: { api: string }[]): string[] {
    return refs.map((r: { api: string }) => r.api).sort();
}

describe('approved topology and build contract discovery over the example apps', () => {
    const approved = approvedExampleRelations();
    const result = new ApiUsageScanner(WORKSPACE_ROOT, exampleProjects()).scan();

    it('detects the api-lib projects by their @ApiPath abstract classes', () => {
        expect(result.apiLibProjects.has('client-server-api')).toBe(true);
        expect(result.apiLibProjects.has('server2-api')).toBe(true);
        expect(result.apiLibProjects.has('client-server')).toBe(false);
    });

    it('indexes each API contract with its transport', () => {
        expect(result.apiIndex.get('Server2Api')?.owner).toBe('server2-api');
        expect(result.apiIndex.get('Server2Api')?.type).toBe('rpc');
        expect(result.apiIndex.get('SaveApi')?.owner).toBe('client-server-api');
    });

    it('classifies client-server: implements its own api-lib, uses server2-api', () => {
        const relations = approved.get('client-server');
        expect(relations).toBeDefined();

        const impl = relations!['client-server-api'] as ApiRelation;
        expect(impl.kind).toBe('implements');
        expect(apiNames(impl.implements)).toEqual(['PublicApi', 'SaveApi', 'SecureApi']);
        expect(impl.uses).toEqual([]);

        const uses = relations!['server2-api'] as ApiRelation;
        expect(uses.kind).toBe('uses');
        expect(apiNames(uses.uses)).toEqual(['Server2Api']);
        expect(uses.uses[0].type).toBe('rpc');
    });

    it('classifies angular-site as a pure user of client-server-api', () => {
        const relations = approved.get('angular-site');
        expect(relations).toBeDefined();
        const uses = relations!['client-server-api'] as ApiRelation;
        expect(uses.kind).toBe('uses');
        expect(apiNames(uses.uses)).toContain('SaveApi');
        expect(uses.implements).toEqual([]);
    });

    it('classifies server2 as a pure implementer of server2-api', () => {
        const relations = approved.get('server2');
        expect(relations).toBeDefined();
        const impl = relations!['server2-api'] as ApiRelation;
        expect(impl.kind).toBe('implements');
        expect(apiNames(impl.implements)).toEqual(['Server2Api']);
    });
});

describe('approved wiring — explicit targets replace legacy config inference', () => {
    const relations = approvedExampleRelations();

    it('retains the Node client destination', () => {
        const uses = relations.get('client-server')!['server2-api'] as ApiRelation;
        expect(uses.uses[0].api).toBe('Server2Api');
        expect(uses.uses[0].targetService).toBe('server2');
    });

    it('retains the Angular destination without false fan-out to legacy-server', () => {
        const uses = relations.get('angular-site')!['client-server-api'] as ApiRelation;
        expect(apiNames(uses.uses)).toEqual(['PublicApi', 'SaveApi']);
        for (const ref of uses.uses) expect(ref.targetService).toBe('client-server');
    });
});

describe('ApiUsageScanner — project-coverage edge cases', () => {
    const result = new ApiUsageScanner(WORKSPACE_ROOT, exampleProjects()).scan();

    it('scans legacy-server through its configured app program and finds its implements', () => {
        expect(result.scannedProjects.has('legacy-server')).toBe(true);
        const relations = result.relationsByProject.get('legacy-server');
        expect(relations).toBeDefined();
        const impl = relations!['client-server-api'] as ApiRelation;
        expect(impl.kind).toBe('implements');
        expect(apiNames(impl.implements)).toEqual(['PublicApi', 'SaveApi']);
    });

    it('does NOT mark an all-test project (app-example-e2e) as scanned', () => {
        expect(result.scannedProjects.has('app-example-e2e')).toBe(false);
        expect(result.relationsByProject.has('app-example-e2e')).toBe(false);
    });
});

describe('buildApiContracts — the per-method trigger table committed to dependencies.json', () => {
    const contracts = buildApiContracts(
        new ApiUsageScanner(WORKSPACE_ROOT, exampleProjects()).scan(),
    );

    it('records each contract with its owner, api kind and @ApiPath basePath', () => {
        expect(contracts['SecureApi'].owner).toBe('client-server-api');
        expect(contracts['SecureApi'].apiKind).toBe('rpc');
        expect(contracts['SecureApi'].basePath).toBe('/secure');
    });

    it('reads every @Endpoint path + kind, and names NO queue for a synchronous rpc method', () => {
        // A queue name belongs only to a `cloudtasks` or `cron` method — those are the kinds actually
        // delivered through one, and Terraform matches on the string. Emitting a plausible-looking
        // `Server2Api-fetchValue` for a synchronous endpoint put it one naive
        // `methods.map(m => m.queueName)` away from being provisioned as a real Cloud Tasks queue.
        expect(contracts['Server2Api'].methods).toEqual([
            {
                name: 'fetchValue',
                path: '/fetchValue',
                kind: 'rpc',
                operation: 'read',
                httpMethod: 'POST',
                parameters: [{ index: 0, source: 'body' }],
            },
        ]);
    });

    it('is deterministic: contracts sorted by name, methods left in declaration order', () => {
        const names = Object.keys(contracts);
        expect(names).toEqual([...names].sort());
        expect(contracts['SecureApi'].methods.map((m: ApiMethodMeta) => m.name)).toEqual([
            'userOp',
            'adminOp',
            'orgOp',
            'internalOp',
            'serviceOp',
        ]);
    });
});
