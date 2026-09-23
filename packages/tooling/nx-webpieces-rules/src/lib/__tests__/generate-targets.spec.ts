import { describe, it, expect } from 'vitest';
import type { CreateNodesResult, ProjectConfiguration, TargetConfiguration } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';
import { specTempDirs } from '@webpieces/rules-config';
import { createNodesV2 } from '../../plugin';
import { GenerateWiring, GenerateWiringProblem, ProjectDependency } from '../generated-docs/generate-wiring';

/** The api library, in the shape #1021 prescribes. */
function apiProject(tags: string[]): object {
    return {
        name: 'lang-apis',
        tags,
        targets: {
            compile: { executor: '@nx/js:tsc', options: { outputPath: 'dist/libraries/lang-apis' } },
            'openapi-generate': {
                dependsOn: ['compile'],
                options: { manifest: 'libraries/lang-apis/openapi.manifest.json', format: 'both' },
            },
            build: { executor: 'nx:noop', dependsOn: ['compile', 'openapi-generate'] },
        },
    };
}

/** Run the plugin's createNodes over one project.json and return what it inferred for it. */
async function inferred(projectJson: object): Promise<Record<string, TargetConfiguration>> {
    const root = fs.realpathSync(specTempDirs.make('wp-generate-targets-'));
    fs.mkdirSync(path.join(root, 'libraries', 'lang-apis'), { recursive: true });
    fs.writeFileSync(path.join(root, 'libraries', 'lang-apis', 'project.json'), JSON.stringify(projectJson));
    const createNodes = createNodesV2[1];
    const results = await createNodes(
        ['libraries/lang-apis/project.json'],
        { workspace: { enabled: false } },
        { workspaceRoot: root, nxJsonConfiguration: {} },
    );
    const entry = results.find((pair: readonly [string, CreateNodesResult]) => pair[0] === 'libraries/lang-apis/project.json');
    return entry?.[1].projects?.['libraries/lang-apis']?.targets ?? {};
}

describe('tag-inferred API document targets', () => {
    it('infers NOTHING for an untagged project — zero cost for everybody who did not opt in', async () => {
        const targets = await inferred(apiProject(['role:api-lib']));

        expect(targets['openapi-generate']).toBeUndefined();
        expect(targets['docs-generate']).toBeUndefined();
        expect(targets['ci']!.dependsOn).not.toContain('openapi-generate');
    });

    it('generate:openapi infers openapi-generate, with outputs INTO the compile outputPath, and rides ci', async () => {
        const targets = await inferred(apiProject(['generate:openapi']));

        expect(targets['openapi-generate']).toMatchObject({
            executor: '@webpieces/nx-webpieces-rules:openapi-generate',
            cache: true,
            outputs: [
                '{workspaceRoot}/dist/libraries/lang-apis/*openapi.json',
                '{workspaceRoot}/dist/libraries/lang-apis/*openapi.yaml',
                '{workspaceRoot}/dist/libraries/lang-apis/mcp-*-tools.json',
            ],
        });
        // No options are inferred: every value is the consumer's to state (no defaults).
        expect(targets['openapi-generate']!.options).toBeUndefined();
        expect(targets['docs-generate']).toBeUndefined();
        expect(targets['ci']!.dependsOn).toContain('openapi-generate');
    });

    it('generate:docs-site implies openapi, and docs-generate writes into <projectRoot>/<siteDir>', async () => {
        const targets = await inferred(apiProject(['generate:docs-site']));

        expect(targets['openapi-generate']).toBeDefined();
        expect(targets['docs-generate']).toMatchObject({
            executor: '@webpieces/nx-webpieces-rules:docs-generate',
            dependsOn: ['openapi-generate'],
            outputs: ['{projectRoot}/{options.siteDir}'],
        });
        expect(targets['docs-generate']!.options).toBeUndefined();
        expect(targets['ci']!.dependsOn).toContain('docs-generate');
    });

    it('infers no outputs while dependsOn is unstated — the executor then names the missing key', async () => {
        const project = apiProject(['generate:openapi']) as { targets: Record<string, object> };
        project.targets['openapi-generate'] = { options: {} };

        expect((await inferred(project))['openapi-generate']!.outputs).toEqual([]);
    });
});

/** A resolved nx project, as validate-nx-wiring sees it. */
function project(root: string, tags: string[], targets: Record<string, TargetConfiguration>): ProjectConfiguration {
    return { root, tags, targets };
}

const GOOD_API = project('libraries/lang-apis', ['generate:openapi'], {
    compile: { executor: '@nx/js:tsc', dependsOn: ['^build'], options: { outputPath: 'dist/libraries/lang-apis' } },
    'openapi-generate': { dependsOn: ['compile'] },
    build: { executor: 'nx:noop', dependsOn: ['compile', 'openapi-generate'] },
});

function problems(
    projects: Record<string, ProjectConfiguration>,
    dependencies: Record<string, ProjectDependency[]> = {},
): string[] {
    return new GenerateWiring(projects, dependencies)
        .problems()
        .map((each: GenerateWiringProblem) => `${each.project}: ${each.problem} FIX: ${each.cure}`);
}

describe('GenerateWiring (validate-nx-wiring) enforces the compile → openapi-generate → build shape', () => {
    it('passes the prescribed shape, and ignores untagged projects entirely', () => {
        expect(problems({
            'lang-apis': GOOD_API,
            other: project('libraries/other', [], { build: { executor: '@nx/js:tsc' } }),
        })).toEqual([]);
    });

    it('refuses a build that is still the tsc step, naming the exact edit', () => {
        const api = structuredClone(GOOD_API);
        api.targets!['build'] = { executor: '@nx/js:tsc', dependsOn: ['^build'] };

        expect(problems({ 'lang-apis': api })).toEqual([
            expect.stringMatching(/lang-apis:build must be an nx:noop over "compile" and "openapi-generate"[\s\S]*FIX: Set targets\.build in libraries\/lang-apis\/project\.json to \{ "executor": "nx:noop", "dependsOn": \["compile", "openapi-generate"\] \}/),
        ]);
    });

    it('refuses an openapi-generate with no dependsOn', () => {
        const api = structuredClone(GOOD_API);
        api.targets!['openapi-generate'] = {};

        expect(problems({ 'lang-apis': api })).toEqual([
            expect.stringMatching(/must dependsOn exactly ONE target[\s\S]*FIX: Set "dependsOn": \["compile"\]/),
        ]);
    });

    it('refuses a compile step that does not build its upstreams first', () => {
        const api = structuredClone(GOOD_API);
        api.targets!['compile']!.dependsOn = [];

        expect(problems({ 'lang-apis': api })).toEqual([
            expect.stringMatching(/lang-apis:compile .* does not dependsOn "\^build"/),
        ]);
    });

    it('requires test dependsOn ^build of every project depending on a generating library', () => {
        const server = project('services/lang-server', [], {
            test: { executor: 'nx:run-commands', options: { command: 'vitest run services/lang-server/' } },
        });
        const deps = { 'lang-server': [new ProjectDependency('lang-apis')] };

        expect(problems({ 'lang-apis': GOOD_API, 'lang-server': server }, deps)).toEqual([
            expect.stringMatching(/lang-server depends on lang-apis[\s\S]*FIX: Add "dependsOn": \["\^build"\] to targets\.test in services\/lang-server\/project\.json/),
        ]);

        server.targets!['test']!.dependsOn = ['^build'];
        expect(problems({ 'lang-apis': GOOD_API, 'lang-server': server }, deps)).toEqual([]);
    });
});
