/**
 * Runs the ApiUsageScanner against the real example apps in this repo and asserts
 * the derived implements/uses topology. This is an integration test over actual
 * source, so it doubles as the contract for the arch `apiRelations` field.
 */

import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner } from '../api-usage/api-scanner';
import { ApiRelation } from '../api-usage/api-relations';

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
