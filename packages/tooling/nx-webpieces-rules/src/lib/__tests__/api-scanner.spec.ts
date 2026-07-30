/**
 * Runs the ApiUsageScanner against the real example apps in this repo and asserts
 * the derived implements/uses topology. This is an integration test over actual
 * source, so it doubles as the contract for the arch `apiRelations` field.
 */

import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner, buildApiContracts } from '../api-usage/api-scanner';
import { ApiMethodMeta, ApiRelation } from '../api-usage/api-relations';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../../..');

function exampleProjects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    const add = (name: string, root: string, tags: string[]): void => {
        infos.set(name, new ProjectInfo(name, root, tags));
    };
    add('client-server', 'apps/app-example/client-server', ['framework:express', 'role:server']);
    add('client-server-api', 'apps/app-example/client-server-api', ['framework:browser', 'framework:node', 'role:lib']);
    add('server2', 'apps/app-example/server2', ['framework:express', 'role:server']);
    add('server2-api', 'apps/app-example/server2-api', ['framework:browser', 'framework:node', 'role:lib']);
    add('angular-site', 'apps/app-example/angular-site', ['framework:angular', 'role:client']);
    // legacy-server has only a solution-style tsconfig.json (no tsconfig.app/lib) — exercises the
    // src-glob program fallback. app-example-e2e has only a *.spec.ts — exercises the "not scanned".
    add('legacy-server', 'apps/app-example/legacy-server', ['framework:express', 'role:server']);
    add('app-example-e2e', 'apps/app-example/e2e', ['framework:express', 'role:server']);
    return infos;
}

function apiNames(refs: { api: string }[]): string[] {
    return refs.map((r: { api: string }) => r.api).sort();
}

describe('ApiUsageScanner over the example apps', () => {
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
        const relations = result.relationsByProject.get('client-server');
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
        const relations = result.relationsByProject.get('angular-site');
        expect(relations).toBeDefined();
        const uses = relations!['client-server-api'] as ApiRelation;
        expect(uses.kind).toBe('uses');
        expect(apiNames(uses.uses)).toContain('SaveApi');
        expect(uses.implements).toEqual([]);
    });

    it('classifies server2 as a pure implementer of server2-api', () => {
        const relations = result.relationsByProject.get('server2');
        expect(relations).toBeDefined();
        const impl = relations!['server2-api'] as ApiRelation;
        expect(impl.kind).toBe('implements');
        expect(apiNames(impl.implements)).toEqual(['Server2Api']);
    });
});

/**
 * The client config argument names WHICH service a client talks to. Dropping it is what forced the
 * runtime graph to fan an edge out to every implementer of a contract; keeping it makes the edge
 * single-target. A non-literal config keeps the field ABSENT — "unknown", not "none" — so the graph
 * knows to fall back rather than guess.
 */
describe('ApiUsageScanner — the target service at the call site', () => {
    const result = new ApiUsageScanner(WORKSPACE_ROOT, exampleProjects()).scan();

    it('records the service named by a `new ClientConfig(...)` literal', () => {
        const uses = result.relationsByProject.get('client-server')!['server2-api'] as ApiRelation;
        expect(uses.uses[0].api).toBe('Server2Api');
        expect(uses.uses[0].targetService).toBe('server2');
    });

    it('records nothing when the config is a variable (angular-site passes one in)', () => {
        const uses = result.relationsByProject.get('angular-site')!['client-server-api'] as ApiRelation;
        expect(uses.uses.length).toBeGreaterThan(0);
        for (const ref of uses.uses) expect(ref.targetService).toBeUndefined();
    });
});

describe('ApiUsageScanner — project-coverage edge cases', () => {
    const result = new ApiUsageScanner(WORKSPACE_ROOT, exampleProjects()).scan();

    it('scans legacy-server via the src-glob fallback (solution-style tsconfig) and finds its implements', () => {
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
    const contracts = buildApiContracts(new ApiUsageScanner(WORKSPACE_ROOT, exampleProjects()).scan());

    it('records each contract with its owner, api kind and @ApiPath basePath', () => {
        expect(contracts['SecureApi'].owner).toBe('client-server-api');
        expect(contracts['SecureApi'].apiKind).toBe('rpc');
        expect(contracts['SecureApi'].basePath).toBe('/secure');
    });

    it('reads every @Endpoint path + kind, and derives the Terraform-matched queue name', () => {
        // The queue name is defined for every method (a cron schedule needs a name too), defaulting
        // to `${Api}-${method}` exactly as core-util's getQueueName does.
        expect(contracts['Server2Api'].methods).toEqual([
            { name: 'fetchValue', path: '/fetchValue', kind: 'rpc', queueName: 'Server2Api-fetchValue' },
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
