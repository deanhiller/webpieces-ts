/**
 * Regression: an api-lib with NO tsconfig.base `paths` entry.
 *
 * The consumer's `import { FooApi } from '@x/foo-api'` then resolves through the
 * node_modules symlink to the package's BUILT `dist/index.d.ts`, where tsc has
 * erased `@ApiPath` (decorators are runtime metadata, not type surface). The scan
 * must still see the relation — it reads the decorators from the owning workspace
 * project's SOURCE, not from whatever declaration the checker happened to land on.
 *
 * Builds a throwaway mini-workspace on disk because this bug only exists in the
 * module-resolution layer; it cannot be reproduced from an in-memory AST.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner, describeUnresolvedApiCalls } from '../api-usage/api-scanner';
import { ApiRelation } from '../api-usage/api-relations';

let root = '';

function write(relPath: string, contents: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

/** api-lib source: the decorated contract, as the IDE sees it. */
function writeApiLibSource(): void {
    write(
        'libraries/foo-api/src/decorators.ts',
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function PubSub(): ClassDecorator { return (): void => undefined; }
`,
    );
    write(
        'libraries/foo-api/src/index.ts',
        `import { ApiPath } from './decorators';

@ApiPath('/foo')
export abstract class FooApi {
    abstract run(): Promise<void>;
}
`,
    );
    write(
        'libraries/foo-api/tsconfig.json',
        JSON.stringify({ compilerOptions: { moduleResolution: 'node', experimentalDecorators: true }, include: ['src/**/*.ts'] }),
    );
}

/** api-lib BUILT output: what the checker actually resolves to. Decorators are gone. */
function writeApiLibDist(): void {
    write(
        'libraries/foo-api/dist/index.d.ts',
        `export declare abstract class FooApi {
    abstract run(): Promise<void>;
}
`,
    );
    write(
        'libraries/foo-api/package.json',
        JSON.stringify({ name: '@x/foo-api', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts' }),
    );
}

/** The consuming service: real addRoutes wiring, importing by package name (no paths entry). */
function writeService(): void {
    write(
        'services/foo/src/FooRoutes.ts',
        `import { FooApi } from '@x/foo-api';

class FooController extends FooApi {
    async run(): Promise<void> {}
}

export class FooRoutes {
    configure(router: { addRoutes(api: unknown, ctrl: unknown): void }): void {
        router.addRoutes(FooApi, FooController);
    }
}
`,
    );
    write(
        'services/foo/tsconfig.json',
        JSON.stringify({ compilerOptions: { moduleResolution: 'node', experimentalDecorators: true }, include: ['src/**/*.ts'] }),
    );
}

function linkIntoNodeModules(): void {
    const scopeDir = path.join(root, 'node_modules', '@x');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.symlinkSync(path.join(root, 'libraries/foo-api'), path.join(scopeDir, 'foo-api'), 'dir');
}

function projects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('foo-api', new ProjectInfo('foo-api', 'libraries/foo-api', ['role:lib']));
    infos.set('foo', new ProjectInfo('foo', 'services/foo', ['role:server']));
    return infos;
}

/** The same workspace, but the api-lib's source is NOT a registered project — nothing to recover from. */
function projectsWithoutApiLib(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('foo', new ProjectInfo('foo', 'services/foo', ['role:server']));
    return infos;
}

describe('ApiUsageScanner — api-lib with no tsconfig paths entry', () => {
    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-api-scan-')));
        writeApiLibSource();
        writeApiLibDist();
        writeService();
        linkIntoNodeModules();
    });

    afterAll(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('still indexes the api contract from the api-lib source', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        expect(result.apiIndex.get('FooApi')?.owner).toBe('foo-api');
        expect(result.apiLibProjects.has('foo-api')).toBe(true);
    });

    it('records the IMPLEMENTS relation even though the import resolves to dist/index.d.ts', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        const relations = result.relationsByProject.get('foo');
        expect(relations).toBeDefined();
        const impl = relations!['foo-api'] as ApiRelation;
        expect(impl.kind).toBe('implements');
        expect(impl.implements.map((r: { api: string }) => r.api)).toEqual(['FooApi']);
    });

    it('reports nothing unresolved when every contract maps back to source', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        expect(result.unresolvedApiCalls).toEqual([]);
    });

    it('reports a contract loudly, never silently, when no workspace source owns it', () => {
        const result = new ApiUsageScanner(root, projectsWithoutApiLib()).scan();
        expect(result.relationsByProject.has('foo')).toBe(false);
        expect(result.unresolvedApiCalls).toHaveLength(1);

        const unresolved = result.unresolvedApiCalls[0];
        expect(unresolved.api).toBe('FooApi');
        expect(unresolved.project).toBe('foo');
        expect(unresolved.at).toContain('services/foo/src/FooRoutes.ts:');
        expect(unresolved.declaredIn).toContain('dist/index.d.ts');

        const report = describeUnresolvedApiCalls(result.unresolvedApiCalls);
        expect(report).toContain('FooApi');
        expect(report).toContain('paths');
    });
});
