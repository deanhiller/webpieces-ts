import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpToolCatalogError, McpToolCatalogFile } from '@webpieces/core-util';
import { ApiClient, ApiFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpToolCatalog } from './McpToolCatalog';
import { McpToolRegistry, RegisteredMcpTool } from './McpToolRegistry';
import {
    IN_MEMORY,
    REMOTE_SEARCH_API_CATALOG,
    RemoteSearchApi,
    SEARCH_API_CATALOG,
    SearchApi,
} from './__tests__/WpMcpServerTestFixtures';

/** A factory nothing calls: a registry only VALIDATES bindings, it never invokes them. */
class UnusedApiFactory implements ApiFactory {
    apiClients(): ApiClient[] {
        return [];
    }

    // webpieces-disable no-any-unknown -- mirrors ApiFactory's abstract constructor signature
    createApiClient<T>(_apiPrototype: abstract new (...args: any[]) => T): T {
        throw new Error('a registry never invokes a binding');
    }
}

/**
 * A throwaway filesystem laid out the way the two real environments are:
 *
 * - `built`: a Docker image — `node_modules/@myorg/apis` relinked onto `dist/libraries/apis`, which
 *   holds the compiled package.json AND the generated catalogs;
 * - `source`: local dev and vitest — the server project's `node_modules/@myorg/apis` is a pnpm link
 *   onto the api library's SOURCE directory (project.json, no catalogs), and the catalogs are in the
 *   build target's outputPath under the nx workspace root.
 */
class Layout {
    readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mcp-catalogs-')));

    write(relative: string, content: string): string {
        const file = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return file;
    }

    link(linkRelative: string, targetRelative: string): void {
        const link = path.join(this.root, linkRelative);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.join(this.root, targetRelative), link, 'dir');
    }

    catalog(dirRelative: string, catalog: McpToolCatalog): void {
        this.write(path.join(dirRelative, catalog.file.fileName), catalog.file.toJsonText());
    }

    /** A pnpm workspace: server → link → source dir, with the build output under dist/. */
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static source(projectJson: object, built: boolean): Layout {
        const layout = new Layout();
        layout.write('nx.json', '{}');
        layout.write('libraries/apis/package.json', JSON.stringify({ name: '@myorg/apis' }));
        layout.write('libraries/apis/project.json', JSON.stringify(projectJson));
        layout.write('services/server/src/mountMcp.ts', '');
        layout.link('services/server/node_modules/@myorg/apis', 'libraries/apis');
        if (built) {
            layout.write('dist/libraries/apis/package.json', JSON.stringify({ name: '@myorg/apis' }));
            layout.catalog('dist/libraries/apis', SEARCH_API_CATALOG);
            layout.catalog('dist/libraries/apis', REMOTE_SEARCH_API_CATALOG);
        }
        return layout;
    }
}

/** The api library's project.json, in the shape the nx plugin's wiring validation enforces. */
const API_PROJECT = {
    name: 'apis',
    tags: ['generate:openapi'],
    targets: {
        build: { executor: '@nx/js:tsc', options: { outputPath: 'dist/libraries/apis' } },
        'openapi-generate': {
            dependsOn: ['build'],
            options: { manifest: 'libraries/apis/openapi.manifest.json', format: 'json' },
        },
    },
};

const layouts: Layout[] = [];

function track(layout: Layout): Layout {
    layouts.push(layout);
    return layout;
}

afterEach(() => {
    for (const layout of layouts.splice(0)) fs.rmSync(layout.root, { recursive: true, force: true });
});

describe('McpToolCatalog.fromPackages', () => {
    it('reads a BUILT package: the catalogs sit beside its package.json (Docker relink onto dist)', () => {
        const layout = track(new Layout());
        layout.write('dist/libraries/apis/package.json', JSON.stringify({ name: '@myorg/apis' }));
        layout.catalog('dist/libraries/apis', SEARCH_API_CATALOG);
        layout.catalog('dist/libraries/apis', REMOTE_SEARCH_API_CATALOG);
        layout.write('dist/services/server/src/mountMcp.js', '');
        layout.link('node_modules/@myorg/apis', 'dist/libraries/apis');

        const catalogs = McpToolCatalog.fromPackages(
            ['@myorg/apis'],
            path.join(layout.root, 'dist/services/server/src'),
        );

        expect(catalogs.map((catalog: McpToolCatalog) => catalog.contractName)).toEqual([
            'RemoteSearchApi',
            'SearchApi',
        ]);
        expect(catalogs[1]!.find('account_search')?.description).toBe(
            'Search records owned by the authenticated user.',
        );
        expect(catalogs[0]!.directory).toBe(path.join(layout.root, 'dist/libraries/apis'));
    });

    it('reads a workspace SOURCE dir through its project.json: outputPath of the target openapi-generate dependsOn', () => {
        const layout = track(Layout.source(API_PROJECT, true));

        const catalogs = McpToolCatalog.fromPackages(
            ['@myorg/apis'],
            path.join(layout.root, 'services/server/src'),
        );

        expect(catalogs.map((catalog: McpToolCatalog) => catalog.contractName).sort()).toEqual([
            'RemoteSearchApi',
            'SearchApi',
        ]);
        expect(catalogs[0]!.directory).toBe(path.join(layout.root, 'dist/libraries/apis'));
    });

    it('follows a project-LOCAL outputPath too — the path is read, never assumed to be dist/', () => {
        const project = structuredClone(API_PROJECT);
        project.targets.build.options.outputPath = '{projectRoot}/dist';
        const layout = track(Layout.source(project, false));
        layout.catalog('libraries/apis/dist', SEARCH_API_CATALOG);

        const catalogs = McpToolCatalog.fromPackages(
            ['@myorg/apis'],
            path.join(layout.root, 'services/server/src'),
        );

        expect(catalogs.map((catalog: McpToolCatalog) => catalog.directory)).toEqual([
            path.join(layout.root, 'libraries/apis/dist'),
        ]);
    });

    it('names the build as the cure when the source library was never built', () => {
        const layout = track(Layout.source(API_PROJECT, false));

        expect(() =>
            McpToolCatalog.fromPackages(['@myorg/apis'], path.join(layout.root, 'services/server/src')),
        ).toThrow(/dist\/libraries\/apis — the directory does not exist[\s\S]*"dependsOn": \["\^openapi-generate"\]/);
    });

    it('names the missing dependsOn when openapi-generate does not say which target it writes into', () => {
        const project = structuredClone(API_PROJECT) as { targets: Record<string, object> };
        project.targets['openapi-generate'] = { options: {} };
        const layout = track(Layout.source(project, true));

        expect(() =>
            McpToolCatalog.fromPackages(['@myorg/apis'], path.join(layout.root, 'services/server/src')),
        ).toThrow(/must dependsOn exactly ONE target[\s\S]*Set "dependsOn": \["build"\]/);
    });

    it('names every node_modules directory it searched when the package is not installed', () => {
        const layout = track(new Layout());

        expect(() =>
            McpToolCatalog.fromPackages(['@myorg/nope'], path.join(layout.root, 'a', 'b')),
        ).toThrow(new RegExp(`Searched:[\\s\\S]*${path.join(layout.root, 'a', 'b', 'node_modules')}`));
    });

    it('refuses an empty package list rather than booting a server with no tools', () => {
        expect(() => McpToolCatalog.fromPackages([], __dirname)).toThrow(McpToolCatalogError);
    });
});

describe('McpToolRegistry pairs each binding with ITS contract’s catalog', () => {
    const factory = new UnusedApiFactory();
    const search = (): McpApiBinding => McpApiBinding.local(SearchApi, factory);
    const remote = (): McpApiBinding =>
        McpApiBinding.remote(RemoteSearchApi, () => {
            throw new Error('never invoked');
        });

    it('boots when every bound contract has exactly its own catalog', () => {
        const registry = new McpToolRegistry(
            [search(), remote()],
            [SEARCH_API_CATALOG, REMOTE_SEARCH_API_CATALOG],
        );

        expect(registry.tools.map((tool: RegisteredMcpTool) => tool.name).sort()).toEqual([
            'account_search',
            'admin_search',
            'remote_search',
        ]);
    });

    it('refuses a bound contract with no catalog, naming the file and every directory searched', () => {
        const other = new McpToolCatalog(REMOTE_SEARCH_API_CATALOG.file, '/built/apis');

        expect(() => new McpToolRegistry([search(), remote()], [other])).toThrow(
            /binds SearchApi, and no mcp-SearchApi-tools\.json[\s\S]*Directories searched[\s\S]*\/built\/apis/,
        );
    });

    it('refuses a catalog whose contract is not bound, naming the filter that drops it', () => {
        expect(
            () => new McpToolRegistry([search()], [SEARCH_API_CATALOG, REMOTE_SEARCH_API_CATALOG]),
        ).toThrow(
            /mcp-RemoteSearchApi-tools\.json \(.*\) is the catalog of RemoteSearchApi, which the server does not bind[\s\S]*catalog\.contractName !== 'RemoteSearchApi'/,
        );
    });

    it('refuses two catalogs for one contract', () => {
        const clash = new McpToolCatalog(
            new McpToolCatalogFile('SearchApi', [REMOTE_SEARCH_API_CATALOG.find('remote_search')!]),
            IN_MEMORY,
        );

        expect(() => new McpToolRegistry([search()], [SEARCH_API_CATALOG, clash])).toThrow(
            /Two MCP tool catalogs for SearchApi/,
        );
    });

    it('refuses an empty catalog list, saying so', () => {
        expect(() => new McpToolRegistry([search()], [])).toThrow(/\(none — toolCatalogs is empty\)/);
    });
});
