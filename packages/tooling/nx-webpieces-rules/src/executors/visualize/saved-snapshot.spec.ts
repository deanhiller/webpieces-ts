import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ExecutorContext, CreateNodesContextV2 } from '@nx/devkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { RuleFailError, Option } from '@webpieces/rules-config';
import { SavedSnapshot } from '../../lib/saved-snapshot';
import visualize from './executor';
import visualizeRuntime from '../visualize-runtime/executor';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { RuntimeHtmlPage } from '../../lib/runtime-html-page';
import { createNodesV2 } from '../../plugin';
import { saveGraph } from '../../lib/graph-loader';
import { saveRuntimeGraph } from '../../lib/runtime-graph';

vi.mock('../../lib/runtime-config', () => ({
    loadRuntimeConfig: () => ({ showExternalNodes: true }),
}));

class SnapshotFixture {
    readonly root = specTempDirs.make('saved-architecture-');
    readonly context = { root: this.root } as ExecutorContext;
    readonly graphPath = 'saved/custom.json';
    readonly projects = { saved: { level: 0, dependsOn: [], role: 'lib', framework: ['node'] } };
    readonly runtime = {
        services: {},
        apis: {},
        queues: {},
        runtimeEdges: [],
        unresolvedUses: [],
        triggers: [],
    };

    write(): void {
        saveGraph(this.projects, this.root, this.graphPath);
        saveRuntimeGraph(this.runtime, this.root);
        fs.mkdirSync(path.join(this.root, 'saved/apis'), { recursive: true });
        fs.writeFileSync(path.join(this.root, 'saved/apis/SavedApi.json'), '{"endpoints":[]}');
    }

    facts(): string[] {
        return [
            this.graphPath,
            'architecture/runtime-dependencies.json',
            'saved/apis/SavedApi.json',
        ].map((file) => fs.readFileSync(path.join(this.root, file), 'utf8'));
    }
}

describe('saved architecture viewing', () => {
    beforeEach(() => {
        // Inject compiled browser text at the presentation boundary; keep the real saved-data IO,
        // DOT generation, HTML rendering, and browser fallback behavior under test.
        const generateHTML = GraphVisualizer.prototype.generateHTML;
        vi.spyOn(GraphVisualizer.prototype, 'generateHTML').mockImplementation(function (...args) {
            return generateHTML.apply(new GraphVisualizer(() => '// browser client', () => '// filter client'), args);
        });
        const render = RuntimeHtmlPage.prototype.render;
        vi.spyOn(RuntimeHtmlPage.prototype, 'render').mockImplementation(function (...args) {
            return render.apply(new RuntimeHtmlPage(() => '// browser client', () => '// filter client'), args);
        });
        vi.spyOn(GraphVisualizer.prototype, 'openVisualization').mockReturnValue(false);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it.each(['compile', 'runtime'])(
        'renders structured %s failures with human messages and fix options',
        async (kind) => {
            const fixture = new SnapshotFixture();
            const failure = new RuleFailError(
                'saved-architecture-snapshot',
                'AI-specific message',
                undefined,
                undefined,
                [new Option('Explicit repair option', true)],
                'Human-specific message',
            );
            const method = kind === 'compile' ? 'loadProjects' : 'loadRuntime';
            vi.spyOn(SavedSnapshot.prototype, method).mockImplementation(() => {
                throw failure;
            });
            const result =
                kind === 'compile'
                    ? await visualize({ graphPath: fixture.graphPath }, fixture.context)
                    : await visualizeRuntime({}, fixture.context);
            expect(result).toEqual({ success: false });
            const output = vi.mocked(console.error).mock.calls.flat().join('\n');
            expect(output).toContain('Human-specific message');
            expect(output).toContain('Explicit repair option');
            expect(output).not.toContain('AI-specific message');
            expect(output).not.toContain('pnpm nx run architecture:generate');
        },
    );

    it('infers view targets without generation prerequisites and preserves validation', async () => {
        const fixture = new SnapshotFixture();
        fs.writeFileSync(path.join(fixture.root, 'package.json'), '{}');
        fs.mkdirSync(path.join(fixture.root, 'architecture'));
        const results = await createNodesV2[1](
            ['package.json'],
            {
                workspace: { graphPath: fixture.graphPath },
            },
            { workspaceRoot: fixture.root } as CreateNodesContextV2,
        );
        const architecture = results
            .flatMap((row) => Object.values(row[1].projects ?? {}))
            .find((project) => project.name === 'architecture');
        const targets = architecture!.targets!;
        for (const name of ['visualize', 'visualize-runtime']) {
            expect(targets[name].dependsOn ?? []).toEqual([]);
            expect(targets[name].cache).toBe(false);
        }
        expect(targets['visualize'].options).toEqual({ graphPath: fixture.graphPath });
        expect(targets['generate'].cache).toBe(false);
        expect(targets['validate-complete'].dependsOn).toContain('validate-architecture-unchanged');
        expect(targets['validate-complete'].dependsOn).toContain('validate-api-relations');
        expect(targets['validate-complete'].dependsOn).toContain('validate-runtime-architecture');
    });

    it('renders older saved data with custom paths and leaves all facts unchanged after source edits', async () => {
        const fixture = new SnapshotFixture();
        fixture.write();
        const before = fixture.facts();
        fs.writeFileSync(path.join(fixture.root, 'new-source.ts'), 'class NewSource {}');
        expect(await visualize({ graphPath: fixture.graphPath }, fixture.context)).toEqual({
            success: true,
        });
        expect(await visualizeRuntime({}, fixture.context)).toEqual({ success: true });
        expect(fixture.facts()).toEqual(before);
        const compileHtml = fs.readFileSync(
            path.join(fixture.root, 'architecture/dependencies.html'),
            'utf8',
        );
        const runtimeHtml = fs.readFileSync(
            path.join(fixture.root, 'tmp/webpieces/runtime-architecture.html'),
            'utf8',
        );
        expect(compileHtml).toContain('saved');
        expect(compileHtml).not.toContain('NewSource');
        for (const html of [compileHtml, runtimeHtml]) {
            expect(html).toContain('Saved generated snapshot');
            expect(html).toContain('Freshness unknown');
            expect(html).toContain('pnpm nx run architecture:generate');
            expect(html).toContain('wp-node-menu');
        }
        const output = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(output).toContain('Viewing does not refresh');
        expect(output).toContain('Freshness unknown');
        expect(output).toContain('Open manually:');
        // The generator's persistence boundary updates the facts; a later view uses that snapshot.
        saveGraph({ refreshed: { level: 0, dependsOn: [] } }, fixture.root, fixture.graphPath);
        expect(await visualize({ graphPath: fixture.graphPath }, fixture.context)).toEqual({
            success: true,
        });
        expect(
            fs.readFileSync(path.join(fixture.root, 'architecture/dependencies.html'), 'utf8'),
        ).toContain('refreshed');
    });

    it('fails missing artifacts with their paths and explicit refresh guidance without creating facts', async () => {
        const fixture = new SnapshotFixture();
        expect(await visualize({ graphPath: fixture.graphPath }, fixture.context)).toEqual({
            success: false,
        });
        expect(await visualizeRuntime({}, fixture.context)).toEqual({ success: false });
        const output = vi.mocked(console.error).mock.calls.flat().join('\n');
        expect(output).toContain(fixture.graphPath);
        expect(output).toContain('architecture/runtime-dependencies.json');
        expect(output).toContain('architecture:generate');
        expect(fs.existsSync(path.join(fixture.root, fixture.graphPath))).toBe(false);
        expect(
            fs.existsSync(path.join(fixture.root, 'architecture/runtime-dependencies.json')),
        ).toBe(false);
    });

    it.each(['{', 'null', '[]', '{"projects":null}', '{"projects":{"bad":{"level":0}}}'])(
        'fails malformed/unusable compile data %s with actionable guidance',
        async (data) => {
            const fixture = new SnapshotFixture();
            fixture.write();
            fs.writeFileSync(path.join(fixture.root, fixture.graphPath), data);
            expect(await visualize({ graphPath: fixture.graphPath }, fixture.context)).toEqual({
                success: false,
            });
            const output = vi.mocked(console.error).mock.calls.flat().join('\n');
            expect(output).toContain(fixture.graphPath);
            expect(output).toContain('pnpm nx run architecture:generate');
            expect(fs.readFileSync(path.join(fixture.root, fixture.graphPath), 'utf8')).toBe(data);
        },
    );

    it.each(['{', 'null', '[]', '{}'])('fails malformed/unusable runtime data %s', async (data) => {
        const fixture = new SnapshotFixture();
        fixture.write();
        fs.writeFileSync(path.join(fixture.root, 'architecture/runtime-dependencies.json'), data);
        expect(await visualizeRuntime({}, fixture.context)).toEqual({ success: false });
        const output = vi.mocked(console.error).mock.calls.flat().join('\n');
        expect(output).toContain('architecture/runtime-dependencies.json');
        expect(output).toContain('pnpm nx run architecture:generate');
    });
});
