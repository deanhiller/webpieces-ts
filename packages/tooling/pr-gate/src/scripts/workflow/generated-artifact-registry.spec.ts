import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { matchesAnyGlob } from '@webpieces/rules-config';
import {
    GeneratedArtifactRegistry, GeneratedArtifacts,
    ARTIFACT_SOURCE_FALLBACK, ARTIFACT_SOURCE_NX, FALLBACK_GENERATED_PATHS,
} from './generated-artifact-registry';

// A repo root with NO node_modules/.bin/nx — the "nx unavailable" path.
function emptyRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-registry-'));
}

/**
 * A repo root with a STUB `node_modules/.bin/nx` that writes `graph` to the `--file` path it is given.
 * This exercises the real spawn + read + token-expansion path without needing nx installed.
 */
function rootWithStubNx(graph: string): string {
    const root = emptyRoot();
    const binDir = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fixture = path.join(root, 'fixture-graph.json');
    fs.writeFileSync(fixture, graph);
    // `nx graph --file <out>` => argv[3] is <out>.
    fs.writeFileSync(path.join(binDir, 'nx'),
        `#!/bin/sh\ncp ${JSON.stringify(fixture)} "$3"\n`, { mode: 0o755 });
    return root;
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
    it('falls back to the built-in table when nx is not installed', () => {
        const resolved = new GeneratedArtifactRegistry().resolve(emptyRoot());
        expect(resolved.source).toBe(ARTIFACT_SOURCE_FALLBACK);
        expect(resolved.paths).toEqual(FALLBACK_GENERATED_PATHS.slice());
    });

    it('caches — a second resolve does not re-shell out', () => {
        const registry = new GeneratedArtifactRegistry();
        const root = emptyRoot();
        expect(registry.resolve(root)).toBe(registry.resolve(root));
    });

    it('reads every target\'s `outputs` from the nx graph, expanding {projectRoot} and {workspaceRoot}', () => {
        const resolved = new GeneratedArtifactRegistry().resolve(rootWithStubNx(GRAPH_FIXTURE));
        expect(resolved.source).toBe(ARTIFACT_SOURCE_NX);
        expect(resolved.paths).toEqual([
            'architecture/dependencies.json',
            'packages/tooling/pr-gate/design.json',
            'packages/tooling/pr-gate/design.md',
        ]);
    });

    it('drops outputs still holding a per-invocation token ({options.*} — those are dist/, gitignored)', () => {
        const resolved = new GeneratedArtifactRegistry().resolve(rootWithStubNx(GRAPH_FIXTURE));
        expect(resolved.paths.some((p: string): boolean => p.includes('{'))).toBe(false);
    });

    it('falls back rather than throwing when the graph dump is corrupt', () => {
        const resolved = new GeneratedArtifactRegistry().resolve(rootWithStubNx('not json at all'));
        expect(resolved.source).toBe(ARTIFACT_SOURCE_FALLBACK);
    });

    it('seed() replaces the resolved set (the spec seam)', () => {
        const registry = new GeneratedArtifactRegistry();
        registry.seed(new GeneratedArtifacts(['x/y.json'], ARTIFACT_SOURCE_NX));
        expect(registry.resolve(emptyRoot()).paths).toEqual(['x/y.json']);
    });
});

// The fallback table is only ever consulted through matchesAnyGlob, so these assert the pairing —
// a per-project design.* at any depth, and the architecture artifacts by exact path.
describe('the fallback table classifies what the webpieces nx plugin declares as outputs', () => {
    it('matches design.{json,md,html} at any project depth', () => {
        for (const p of ['packages/tooling/pr-gate/design.json', 'apps/app-example/server2/design.md', 'a/b/c/d/design.html']) {
            expect(matchesAnyGlob(p, FALLBACK_GENERATED_PATHS)).toBe(true);
        }
    });

    it('matches the architecture artifacts', () => {
        expect(matchesAnyGlob('architecture/dependencies.json', FALLBACK_GENERATED_PATHS)).toBe(true);
        expect(matchesAnyGlob('architecture/runtime-dependencies.json', FALLBACK_GENERATED_PATHS)).toBe(true);
    });

    it('does NOT match ordinary source or a hand-written doc under architecture/', () => {
        expect(matchesAnyGlob('packages/tooling/pr-gate/src/index.ts', FALLBACK_GENERATED_PATHS)).toBe(false);
        expect(matchesAnyGlob('architecture/angular-di-analyzer-plan.md', FALLBACK_GENERATED_PATHS)).toBe(false);
    });
});
