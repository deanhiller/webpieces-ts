import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { matchesAnyGlob } from '@webpieces/rules-config';
import { ProcessResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';
import { PrGateFeature } from '../../__tests__/feature-harness';
import {
    GeneratedArtifactRegistry, GeneratedArtifacts,
    ARTIFACT_SOURCE_FALLBACK, ARTIFACT_SOURCE_NX, FALLBACK_GENERATED_PATHS,
} from './generated-artifact-registry';

// A repo root with NO node_modules/.bin/nx — the "nx unavailable" path.
function emptyRoot(): string {
    return specTempDirs.make('wp-registry-');
}

let feature: PrGateFeature;

beforeEach(async () => {
    feature = await PrGateFeature.create();
});

/**
 * A repo root WITH `node_modules/.bin/nx`, whose `nx graph --file <out>` is SCRIPTED (#1381) to write
 * `graph` to the path it is given — the read + token-expansion path, with no nx and no process.
 */
function rootWithStubNx(graph: string): string {
    const root = emptyRoot();
    const nx = path.join(root, 'node_modules', '.bin', 'nx');
    fs.mkdirSync(path.dirname(nx), { recursive: true });
    fs.writeFileSync(nx, '');
    feature.processes.respondToPrefix(nx, ['graph', '--file'], (call: ProcessCallDto): ProcessResultDto => {
        fs.writeFileSync(call.args[2], graph);
        return feature.processes.ok();
    });
    return root;
}

function registry(): GeneratedArtifactRegistry {
    return feature.container.get(GeneratedArtifactRegistry);
}

const GRAPH_FIXTURE = JSON.stringify({
    graph: {
        nodes: {
            'pr-gate': {
                data: {
                    root: 'packages/tooling/pr-gate',
                    targets: {
                        'di-graph-generate': { outputs: ['{projectRoot}/design.json', '{projectRoot}/design.md'] },
                        lint: { outputs: ['{options.outputFile}'] },
                        build: { outputs: ['{options.outputPath}'] },
                    },
                },
            },
            architecture: {
                data: {
                    root: 'architecture',
                    targets: {
                        generate: { outputs: ['{workspaceRoot}/architecture/dependencies.json'] },
                        help: {},
                    },
                },
            },
        },
    },
});

describe('GeneratedArtifactRegistry', () => {
    it('falls back to the built-in table when nx is not installed', async () => {
        const resolved = await registry().resolve(emptyRoot());
        expect(resolved.source).toBe(ARTIFACT_SOURCE_FALLBACK);
        expect(resolved.paths).toEqual(FALLBACK_GENERATED_PATHS.slice());
    });

    it('caches — a second resolve does not re-shell out', async () => {
        const root = rootWithStubNx(GRAPH_FIXTURE);
        const first = await registry().resolve(root);
        expect(await registry().resolve(root)).toBe(first);
        // ONE `nx graph` for the life of the process.
        expect(feature.processes.calls).toHaveLength(1);
    });

    it('reads every target\'s `outputs` from the nx graph, expanding {projectRoot} and {workspaceRoot}', async () => {
        const resolved = await registry().resolve(rootWithStubNx(GRAPH_FIXTURE));
        expect(resolved.source).toBe(ARTIFACT_SOURCE_NX);
        expect(resolved.paths).toEqual([
            'architecture/dependencies.json',
            'packages/tooling/pr-gate/design.json',
            'packages/tooling/pr-gate/design.md',
        ]);
    });

    it('drops outputs still holding a per-invocation token ({options.*} — those are dist/, gitignored)', async () => {
        const resolved = await registry().resolve(rootWithStubNx(GRAPH_FIXTURE));
        expect(resolved.paths.some((p: string): boolean => p.includes('{'))).toBe(false);
    });

    it('falls back when `nx graph` itself fails', async () => {
        const root = emptyRoot();
        const nx = path.join(root, 'node_modules', '.bin', 'nx');
        fs.mkdirSync(path.dirname(nx), { recursive: true });
        fs.writeFileSync(nx, '');
        feature.processes.respondToPrefix(nx, ['graph'], feature.processes.fail(1, 'NX   Could not create project graph'));
        expect((await registry().resolve(root)).source).toBe(ARTIFACT_SOURCE_FALLBACK);
    });

    it('falls back rather than throwing when the graph dump is corrupt', async () => {
        const resolved = await registry().resolve(rootWithStubNx('not json at all'));
        expect(resolved.source).toBe(ARTIFACT_SOURCE_FALLBACK);
    });

    it('seed() replaces the resolved set (the spec seam)', async () => {
        registry().seed(new GeneratedArtifacts(['x/y.json'], ARTIFACT_SOURCE_NX));
        expect((await registry().resolve(emptyRoot())).paths).toEqual(['x/y.json']);
    });
});

// The fallback table is only ever consulted through matchesAnyGlob, so these assert the pairing —
// a per-project design.* at any depth, and the architecture artifacts by exact path.
describe('the fallback table classifies what the webpieces nx plugin declares as outputs', () => {
    it('matches design.{json,md,html} at any project depth', async () => {
        for (const p of ['packages/tooling/pr-gate/design.json', 'apps/app-example/server2/design.md', 'a/b/c/d/design.html']) {
            expect(matchesAnyGlob(p, FALLBACK_GENERATED_PATHS)).toBe(true);
        }
    });

    it('matches the architecture artifacts', async () => {
        expect(matchesAnyGlob('architecture/dependencies.json', FALLBACK_GENERATED_PATHS)).toBe(true);
        expect(matchesAnyGlob('architecture/runtime-dependencies.json', FALLBACK_GENERATED_PATHS)).toBe(true);
        expect(matchesAnyGlob('architecture/apis/SaveApi.json', FALLBACK_GENERATED_PATHS)).toBe(true);
    });

    it('does NOT match ordinary source or a hand-written doc under architecture/', async () => {
        expect(matchesAnyGlob('packages/tooling/pr-gate/src/index.ts', FALLBACK_GENERATED_PATHS)).toBe(false);
        expect(matchesAnyGlob('architecture/angular-di-analyzer-plan.md', FALLBACK_GENERATED_PATHS)).toBe(false);
    });
});
