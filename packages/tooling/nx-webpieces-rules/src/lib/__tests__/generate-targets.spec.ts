import { describe, it, expect } from 'vitest';
import type { CreateNodesResult, ProjectConfiguration, TargetConfiguration } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';
import { Option, specTempDirs } from '@webpieces/rules-config';
import { createNodesV2 } from '../../plugin';
import {
    DeclaredDependsOn,
    GenerateWiring,
    GenerateWiringProblem,
    ProjectDependency,
    TargetDefault,
    WiringSourceReader,
} from '../api-docs/generate-wiring';

/** The api library, in the shape #1023 prescribes: tsc stays `build`, generation dependsOn it. */
function apiProject(tags: string[]): object {
    return {
        name: 'lang-apis',
        tags,
        targets: {
            build: { executor: '@nx/js:tsc', options: { outputPath: 'dist/libraries/lang-apis' } },
            'openapi-generate': {
                dependsOn: ['build'],
                options: { manifest: 'libraries/lang-apis/openapi.manifest.json', format: 'both' },
            },
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

    it('generate:openapi infers openapi-generate, with outputs INTO the build outputPath, and rides ci', async () => {
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
    build: {
        executor: '@nx/js:tsc',
        dependsOn: ['^build', '^openapi-generate'],
        options: { outputPath: 'dist/libraries/lang-apis' },
    },
    'openapi-generate': { dependsOn: ['build'] },
});

/** monorepo6's nx.json targetDefaults as they stand before the upgrade — no ^openapi-generate anywhere. */
const CONSUMER_DEFAULTS: Record<string, TargetDefault> = {
    '@nx/js:tsc': new TargetDefault(['^build']),
    build: new TargetDefault(['^build']),
    test: new TargetDefault(undefined),
};

/** lang-server: a tsc build (governed by the "@nx/js:tsc" key) and a run-commands test ("test" key). */
function server(buildDependsOn: string[], testDependsOn: string[] | undefined): ProjectConfiguration {
    return project('services/server/lang-server', [], {
        build: {
            executor: '@nx/js:tsc',
            dependsOn: buildDependsOn,
            options: { outputPath: 'dist/services/lang-server' },
        },
        test: {
            executor: 'nx:run-commands',
            dependsOn: testDependsOn,
            options: { command: 'vitest run services/server/lang-server/' },
        },
    });
}

class Wiring {
    constructor(
        readonly projects: Record<string, ProjectConfiguration>,
        readonly dependencies: Record<string, ProjectDependency[]> = {},
        readonly defaults: Record<string, TargetDefault> = CONSUMER_DEFAULTS,
        readonly declared: DeclaredDependsOn = new DeclaredDependsOn({}),
    ) {}

    wiring(): GenerateWiring {
        return new GenerateWiring(this.projects, this.dependencies, this.defaults, this.declared);
    }

    problems(): string[] {
        return this.wiring()
            .problems()
            .map((each: GenerateWiringProblem) => `${each.project}: ${each.problem} FIX: ${each.cure}`);
    }
}

const SERVER_DEPS = { 'lang-server': [new ProjectDependency('lang-apis')] };

describe("GenerateWiring (validate-nx-wiring) checks the RESOLVED graph for nx's codegen shape", () => {
    it('passes the prescribed shape: openapi-generate dependsOn build, dependents carry ^openapi-generate', () => {
        const fixed = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-server': server(['^build', '^openapi-generate'], ['^openapi-generate']) },
            SERVER_DEPS,
        );
        expect(fixed.problems()).toEqual([]);
    });

    it('ignores projects with no generating library upstream entirely', () => {
        const other = project('libraries/other', [], {
            build: { executor: '@nx/js:tsc', dependsOn: ['^build'] },
            test: {},
        });
        expect(new Wiring({ 'lang-apis': GOOD_API, other }).problems()).toEqual([]);
    });

    it("refuses #1021's compile split, naming the tsc-target-name bug and the edit back", () => {
        const split = project('libraries/lang-apis', ['generate:openapi'], {
            compile: { executor: '@nx/js:tsc', options: { outputPath: 'dist/libraries/lang-apis' } },
            'openapi-generate': { dependsOn: ['compile'] },
            build: { executor: 'nx:noop', dependsOn: ['compile', 'openapi-generate'] },
        });

        const found = new Wiring({ 'lang-apis': split }).problems();
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('dependsOn "compile", and must dependsOn "build"');
        expect(found[0]).toContain('TS6059 (nrwl/nx#18257)');
        expect(found[0]).toContain(
            'FIX: lang-apis: in libraries/lang-apis/project.json, name the @nx/js:tsc target "build" again',
        );
        expect(found[0]).toContain('set targets.openapi-generate.dependsOn to ["build"]');
    });

    it('refuses an openapi-generate with no dependsOn', () => {
        const api = structuredClone(GOOD_API);
        api.targets!['openapi-generate'] = {};

        const found = new Wiring({ 'lang-apis': api }).problems();
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('must dependsOn exactly ONE target');
        expect(found[0]).toContain('FIX: lang-apis: Set "dependsOn": ["build"]');
    });

    it('names the EXECUTOR key for a tsc build and the target-name key for a run-commands test, with the exact line', () => {
        const unwired = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-server': server(['^build'], undefined) },
            SERVER_DEPS,
        );

        const found = unwired.problems();
        expect(found).toHaveLength(2);
        expect(found[0]).toMatch(/^lang-server:build: depends on lang-apis, which generates API documents/);
        expect(found[0]).toContain(
            'FIX: In nx.json, set targetDefaults["@nx/js:tsc"].dependsOn so the entry reads ' +
                '"@nx/js:tsc": { "dependsOn": ["^build", "^openapi-generate"] }',
        );
        expect(found[1]).toMatch(/^lang-server:test: depends on lang-apis/);
        expect(found[1]).toContain(
            'FIX: In nx.json, set targetDefaults["test"].dependsOn so the entry reads ' +
                '"test": { "dependsOn": ["^openapi-generate"] }',
        );
    });

    it('reaches a TRANSITIVE dependent, and groups every project one nx.json edit fixes into one problem', () => {
        const lib = project('libraries/lang-lib', [], {
            build: {
                executor: '@nx/js:tsc',
                dependsOn: ['^build'],
                options: { outputPath: 'dist/libraries/lang-lib' },
            },
        });
        const deps = {
            'lang-server': [new ProjectDependency('lang-lib')],
            'lang-lib': [new ProjectDependency('lang-apis')],
        };
        const unwired = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-lib': lib, 'lang-server': server(['^build'], ['^build']) },
            deps,
        );

        const found = unwired.problems();
        expect(found).toHaveLength(2);
        expect(found[0]).toMatch(/^lang-lib:build, lang-server:build: depends on lang-apis/);
    });

    it('sends the cure to project.json when the project overrides dependsOn there — nx does not merge it', () => {
        const unwired = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-server': server(['^build', '^openapi-generate'], ['^build']) },
            SERVER_DEPS,
            CONSUMER_DEFAULTS,
            new DeclaredDependsOn({ 'lang-server': ['test'] }),
        );

        const found = unwired.problems();
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(
            "FIX: In services/server/lang-server/project.json, targets.test.dependsOn REPLACES nx.json's",
        );
        expect(found[0]).toContain('"dependsOn": ["^build", "^openapi-generate"]');
    });

    it('adds a targetDefaults entry when no key governs the target yet', () => {
        const unwired = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-server': server(['^openapi-generate'], undefined) },
            SERVER_DEPS,
            {},
        );

        expect(unwired.problems()).toEqual([
            expect.stringContaining(
                'FIX: In nx.json, add the targetDefaults entry "test": { "dependsOn": ["^openapi-generate"] }',
            ),
        ]);
    });

    it("accepts nx's object form of ^openapi-generate", () => {
        const wired = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-server': server(['^build', '^openapi-generate'], []) },
            SERVER_DEPS,
        );
        wired.projects['lang-server']!.targets!['test']!.dependsOn = [
            { target: 'openapi-generate', dependencies: true },
        ];

        expect(wired.problems()).toEqual([]);
    });

    it('refuses a hand-written executor on an UNTAGGED project — the tag is the one way to opt in', () => {
        const handWritten = project('libraries/other', [], {
            'openapi-generate': { executor: '@webpieces/nx-webpieces-rules:openapi-generate' },
        });

        const found = new Wiring({ other: handWritten }).problems();
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('names the executor @webpieces/nx-webpieces-rules:openapi-generate by hand');
        expect(found[0]).toContain('FIX: other: add "generate:openapi" to "tags" in libraries/other/project.json');
    });

    it('renders every problem as ONE RuleFailError, one fix Option per problem', () => {
        const unwired = new Wiring(
            { 'lang-apis': GOOD_API, 'lang-server': server(['^build'], undefined) },
            SERVER_DEPS,
        );
        const wiring = unwired.wiring();

        const failure = wiring.failure(wiring.problems());

        expect(failure.humanMessage).toContain('lang-server:build: depends on lang-apis');
        expect(failure.fixOptions.map((option: Option) => option.text)).toEqual([
            expect.stringContaining('targetDefaults["@nx/js:tsc"]'),
            expect.stringContaining('targetDefaults["test"]'),
        ]);
    });
});

describe('WiringSourceReader reads what the resolved graph merged away', () => {
    it('reads nx.json targetDefaults and which targets a project.json declares dependsOn for', () => {
        const root = fs.realpathSync(specTempDirs.make('wp-wiring-sources-'));
        fs.writeFileSync(
            path.join(root, 'nx.json'),
            JSON.stringify({ targetDefaults: { test: { dependsOn: ['^build'] }, lint: {} } }),
        );
        fs.mkdirSync(path.join(root, 'services', 'srv'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'services', 'srv', 'project.json'),
            JSON.stringify({ targets: { test: { dependsOn: ['^build'] }, build: { executor: '@nx/js:tsc' } } }),
        );
        const reader = new WiringSourceReader(root);

        expect(reader.targetDefaults()['test']!.dependsOn).toEqual(['^build']);
        expect(reader.targetDefaults()['lint']!.dependsOn).toBeUndefined();
        const declared = reader.declaredDependsOn({
            srv: { root: 'services/srv' },
            inferred: { root: 'libraries/none' },
        });
        expect(declared.declares('srv', 'test')).toBe(true);
        expect(declared.declares('srv', 'build')).toBe(false);
        expect(declared.declares('inferred', 'test')).toBe(false);
    });
});
