/**
 * Tests for the "unexplained api-lib dependency" validator: a server/client that
 * depends on an api-lib must implement or use it. Runs the finder over synthetic
 * graphs (fast, deterministic) using a hand-built scan result.
 */

import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import { ProjectInfo } from '../project-info';
import type { ApiScanResult } from '../api-usage/api-scanner';
import { findUnclassifiedApiDeps } from '../api-usage/api-relations-validator';

function infos(entries: [string, string[]][]): Map<string, ProjectInfo> {
    const map = new Map<string, ProjectInfo>();
    for (const entry of entries) {
        map.set(entry[0], new ProjectInfo(entry[0], `apps/${entry[0]}`, entry[1]));
    }
    return map;
}

function scanResult(apiLibs: string[]): ApiScanResult {
    const apiIndex = new Map<string, { api: string; owner: string; type: 'rpc' | 'pubsub' }>();
    apiIndex.set('SaveApi', { api: 'SaveApi', owner: 'client-server-api', type: 'rpc' });
    return {
        relationsByProject: new Map(),
        apiLibProjects: new Set(apiLibs),
        apiIndex,
        // Every server/client in these tests has real production source.
        scannedProjects: new Set(['client-server', 'some-lib']),
    };
}

describe('findUnclassifiedApiDeps', () => {
    it('flags a server that depends on an api-lib with no implements/uses', () => {
        const graph: EnhancedGraph = {
            'client-server': { level: 2, dependsOn: ['client-server-api'], role: 'server' },
            'client-server-api': { level: 1, dependsOn: [], role: 'api-lib' },
        };
        const violations = findUnclassifiedApiDeps(
            graph,
            infos([
                ['client-server', ['role:server']],
                ['client-server-api', ['role:api-lib']],
            ]),
            scanResult(['client-server-api']),
        );
        expect(violations).toHaveLength(1);
        expect(violations[0].project).toBe('client-server');
        expect(violations[0].apiLib).toBe('client-server-api');
        expect(violations[0].apis).toEqual(['SaveApi']);
    });

    it('passes when the server implements or uses the api-lib', () => {
        const graph: EnhancedGraph = {
            'client-server': {
                level: 2,
                dependsOn: ['client-server-api'],
                role: 'server',
                apiRelations: {
                    'client-server-api': { kind: 'implements', implements: [{ api: 'SaveApi', type: 'rpc' }], uses: [] },
                },
            },
            'client-server-api': { level: 1, dependsOn: [], role: 'api-lib' },
        };
        const violations = findUnclassifiedApiDeps(
            graph,
            infos([
                ['client-server', ['role:server']],
                ['client-server-api', ['role:api-lib']],
            ]),
            scanResult(['client-server-api']),
        );
        expect(violations).toEqual([]);
    });

    it('ignores non-api-lib deps and non-server/client roles', () => {
        const graph: EnhancedGraph = {
            'some-lib': { level: 1, dependsOn: ['client-server-api'], role: 'lib' },
            'client-server': { level: 2, dependsOn: ['core-util'], role: 'server' },
            'client-server-api': { level: 1, dependsOn: [], role: 'api-lib' },
            'core-util': { level: 0, dependsOn: [], role: 'lib' },
        };
        const violations = findUnclassifiedApiDeps(
            graph,
            infos([
                ['some-lib', ['role:lib']],
                ['client-server', ['role:server']],
                ['client-server-api', ['role:api-lib']],
                ['core-util', ['role:lib']],
            ]),
            scanResult(['client-server-api']),
        );
        // some-lib is role:lib (not checked); client-server depends only on a plain lib.
        expect(violations).toEqual([]);
    });
});

describe('findUnclassifiedApiDeps — scan-coverage', () => {
    it('skips a server whose production source was never scanned (all-test project)', () => {
        const graph: EnhancedGraph = {
            e2e: { level: 2, dependsOn: ['client-server-api'], role: 'server' },
            'client-server-api': { level: 1, dependsOn: [], role: 'api-lib' },
        };
        // scanResult's scannedProjects does NOT include 'e2e' → it must not be flagged.
        const violations = findUnclassifiedApiDeps(
            graph,
            infos([
                ['e2e', ['role:server']],
                ['client-server-api', ['role:api-lib']],
            ]),
            scanResult(['client-server-api']),
        );
        expect(violations).toEqual([]);
    });
});
