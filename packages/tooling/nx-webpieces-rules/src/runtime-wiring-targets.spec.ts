import { describe, it, expect } from 'vitest';
import type { ProjectGraphProjectNode, TargetConfiguration } from '@nx/devkit';
import {
    getImplicitlyTouchedProjects,
    getTouchedProjects,
} from 'nx/src/project-graph/affected/locators/workspace-projects';
import { RawProjectJson } from './generate-targets';
import { RuntimeWiringTargets } from './runtime-wiring-targets';

const BUILD = { executor: '@nx/js:tsc', options: { outputPath: 'dist/services/x' } };

function inferCheck(name: string, tag: string): TargetConfiguration {
    const targets = new RuntimeWiringTargets().infer(
        new RawProjectJson(name, [tag], { build: BUILD }),
    );
    return targets['runtime-wiring-check'];
}

function node(name: string, root: string, tag: string): ProjectGraphProjectNode {
    const targets = new RuntimeWiringTargets().infer(
        new RawProjectJson(name, [tag], { build: BUILD }),
    );
    return { name, type: 'lib', data: { root, tags: [tag], targets } };
}

function fileChange(file: string): { file: string; hash: string; getChanges: () => [] } {
    return { file, hash: 'h', getChanges: () => [] };
}

// The nx.json namedInputs this repo (and the reference consumer) declares.
const NX_JSON = { namedInputs: { default: ['{projectRoot}/**/*'] } };

describe('RuntimeWiringTargets runtime-wiring-check inputs (#1263)', () => {
    it('declares only the project, its graph dependencies and the plugin release', () => {
        expect(inferCheck('svc-a', 'webpieces').inputs).toEqual([
            'default',
            '{projectRoot}/src/wiring.ts',
            '{projectRoot}/runtime-deps.json',
            '^default',
            { externalDependencies: ['@webpieces/nx-webpieces-rules'] },
        ]);
    });

    it('carries no {workspaceRoot} input, so nothing fans out to every tagged project', () => {
        for (const tag of ['webpieces', 'webpieces-lib']) {
            const inputs: unknown[] = inferCheck('svc-a', tag).inputs ?? [];
            const workspaceWide = inputs.filter(
                (input: unknown) => typeof input === 'string' && input.startsWith('{workspaceRoot}'),
            );
            expect(workspaceWide).toEqual([]);
            expect(inputs).not.toContain('{workspaceRoot}/**/src/wiring.ts');
            expect(inputs).not.toContain('{workspaceRoot}/**/runtime-deps.json');
            expect(inputs).not.toContain('{workspaceRoot}/tsconfig.base.json');
        }
    });

    it("changing one service's wiring.ts touches only that service under nx's affected locators", () => {
        const nodes = {
            'svc-x': node('svc-x', 'services/x', 'webpieces'),
            'svc-y': node('svc-y', 'services/y', 'webpieces'),
            'lib-z': node('lib-z', 'libraries/z', 'webpieces-lib'),
        };
        const changes = [fileChange('services/x/src/wiring.ts')];
        expect(getTouchedProjects(changes, nodes)).toEqual(['svc-x']);
        expect(getImplicitlyTouchedProjects(changes, nodes, NX_JSON)).toEqual([]);
    });

    it('a tsconfig.base.json or another runtime-deps.json change touches no tagged project implicitly', () => {
        const nodes = {
            'svc-x': node('svc-x', 'services/x', 'webpieces'),
            'svc-y': node('svc-y', 'services/y', 'webpieces'),
        };
        for (const file of ['tsconfig.base.json', 'services/y/runtime-deps.json', 'webpieces.config.json'])
            expect(getImplicitlyTouchedProjects([fileChange(file)], nodes, NX_JSON)).toEqual([]);
    });

    it('untagged projects get no runtime-wiring-check', () => {
        expect(new RuntimeWiringTargets().infer(new RawProjectJson('plain', ['lib'], { build: BUILD }))).toEqual({});
    });
});
