import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ExecutorContext, CreateNodesContextV2 } from '@nx/devkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import visualizeRuntime from './executor';
import validateRuntime from '../validate-runtime-architecture/executor';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { RuntimeHtmlPage } from '../../lib/runtime-html-page';
import { createNodesV2 } from '../../plugin';
import { saveGraph } from '../../lib/graph-loader';
import { deriveRuntimeGraph, saveRuntimeGraph } from '../../lib/runtime-graph';
import { ImpactRefresh } from '../../lib/graph-impact';
import { TagTruthRules } from '../../lib/tag-truth';
import { DEFAULT_RUNTIME_GOAL_PATH, RUNTIME_GOAL_PREPARE_COMMAND } from '../../lib/runtime-goal-file';
import type { EnhancedGraph } from '../../lib/graph-sorter';
import type { RuntimeGraph } from '../../lib/runtime-graph-model';
import { RuntimeNodeLevels } from '../../lib/runtime-node-levels';

// webpieces-disable no-implicit-any -- vitest types importOriginal from vi.mock's own signature
vi.mock('../../lib/runtime-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/runtime-config')>()),
    loadRuntimeConfig: () => ({ off: false, showExternalNodes: true, externalApiPaths: [] }),
}));

const CURRENT = 'architecture/runtime-dependencies.json';

/** A workspace whose saved current graph has one server; the goal proposes a second, unbuilt one. */
class GoalWorkspace {
    readonly root = specTempDirs.make('runtime-goal-');
    readonly context = { root: this.root } as ExecutorContext;
    readonly projects: EnhancedGraph = {
        'lib-util': { level: 0, dependsOn: [], role: 'lib', framework: ['node'] },
        'crm-manager': { level: 1, dependsOn: ['lib-util'], role: 'server', framework: ['node'] },
    };
    readonly current: RuntimeGraph = deriveRuntimeGraph(this.projects);

    goal(): RuntimeGraph {
        const goal = JSON.parse(JSON.stringify(this.current)) as RuntimeGraph;
        goal.services['billing'] = { level: 0, levelBecause: '', role: 'server', implements: ['BillingApi'], uses: [], dependsOn: [] };
        goal.runtimeEdges.push({ from: 'crm-manager', to: 'billing', via: ['BillingApi'], type: 'rpc' });
        new RuntimeNodeLevels().apply(goal);
        return goal;
    }

    write(current = true, goal: RuntimeGraph | string | null = this.goal()): this {
        saveGraph(this.projects, this.root);
        if (current) saveRuntimeGraph(this.current, this.root);
        if (typeof goal === 'string') this.put(DEFAULT_RUNTIME_GOAL_PATH, goal);
        else if (goal !== null) saveRuntimeGraph(goal, this.root, DEFAULT_RUNTIME_GOAL_PATH);
        return this;
    }

    put(file: string, text: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, file)), { recursive: true });
        fs.writeFileSync(path.join(this.root, file), text);
    }

    read(file: string): string | null {
        const full = path.join(this.root, file);
        return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    }

    out(name: string): string | null {
        return this.read(`tmp/webpieces/${name}`);
    }
}

/** The one field of an inferred project this spec reads. */
class NamedProject {
    name?: string;
}

function logged(): string {
    return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().join('\n');
}

function errors(): string {
    return vi.mocked(console.error).mock.calls.flat().join('\n');
}

describe('architecture:visualize-runtime with a runtime goal (#1239, #1373)', () => {
    beforeEach(() => {
        const render = RuntimeHtmlPage.prototype.render;
        vi.spyOn(RuntimeHtmlPage.prototype, 'render').mockImplementation(function (...args) {
            return render.apply(new RuntimeHtmlPage(() => '// browser client', () => '// filter client', () => '// shared client'), args);
        });
        vi.spyOn(GraphVisualizer.prototype, 'openVisualization').mockReturnValue(false);
        vi.spyOn(TagTruthRules, 'fromConfig').mockReturnValue(TagTruthRules.none());
        vi.spyOn(ImpactRefresh.prototype, 'run').mockResolvedValue('ℹ️  Impact stubbed');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('infers visualize-runtime alone: there is no separate goal target any more (#1373)', async () => {
        const workspace = new GoalWorkspace();
        workspace.put('package.json', '{}');
        fs.mkdirSync(path.join(workspace.root, 'architecture'), { recursive: true });
        const results = await createNodesV2[1](['package.json'], {}, { workspaceRoot: workspace.root } as CreateNodesContextV2);
        // webpieces-disable no-implicit-any -- nx types the createNodes result rows
        const projects = results.flatMap((row) => Object.values(row[1].projects ?? {}));
        const architecture = projects.find((project: NamedProject) => project.name === 'architecture');
        const targets = architecture!.targets!;
        expect(targets['visualize-runtime'].executor).toBe('@webpieces/nx-webpieces-rules:visualize-runtime');
        expect(Object.keys(targets).filter((name: string) => name.includes('goal'))).toEqual([]);
        expect(RUNTIME_GOAL_PREPARE_COMMAND).toBe('pnpm nx run architecture:visualize-runtime --prepare-goal');
    });

    it('gives the current page Goal vs Current when a goal exists, leaving both JSON inputs byte-for-byte', async () => {
        const workspace = new GoalWorkspace().write();
        const before = [workspace.read(CURRENT), workspace.read(DEFAULT_RUNTIME_GOAL_PATH)];
        expect(await visualizeRuntime({}, workspace.context)).toEqual({ success: true });
        expect([workspace.read(CURRENT), workspace.read(DEFAULT_RUNTIME_GOAL_PATH)]).toEqual(before);
        const html = workspace.out('runtime-architecture.html')!;
        expect(html).toContain('Saved generated snapshot');
        // A proposed service absent from the saved project graph still renders from its goal facts.
        expect(html).toContain('Service billing — added');
        expect(html).toContain('<span class="wp-mode-name">Goal vs Current</span><span class="wp-mode-sub">Current → Goal proposal</span>');
        expect(html).not.toMatch(/data-wp-mode="goal"[^>]*disabled/);
        expect(workspace.out('runtime-architecture-goal.html')).toBeNull();
        expect(logged()).toContain('Goal vs Current: 2 added');
    });

    it('dims Goal vs Current and says the goal file does not exist when there is none (#1373)', async () => {
        const workspace = new GoalWorkspace().write(true, null);
        expect(await visualizeRuntime({}, workspace.context)).toEqual({ success: true });
        const html = workspace.out('runtime-architecture.html')!;
        const item = html.match(/<button[^>]*data-wp-mode="goal"[^>]*>[\s\S]*?<\/button>/)![0];
        expect(item).toContain(' disabled aria-disabled="true"');
        expect(item).toContain('<span class="wp-mode-sub">runtime-dependencies-goal.json does not exist</span>');
        expect(item).not.toContain('Current → Goal proposal');
        // The tooltip and the console keep the full reason, with how to start a goal.
        expect(item).toContain(`title="No runtime goal at ${DEFAULT_RUNTIME_GOAL_PATH}. Start a proposal with: cp ${CURRENT} ${DEFAULT_RUNTIME_GOAL_PATH}"`);
        expect(logged()).toContain(`Goal vs Current unavailable: No runtime goal at ${DEFAULT_RUNTIME_GOAL_PATH}`);
        // The other modes stay selectable.
        expect(html).not.toMatch(/data-wp-mode="runtime"[^>]*disabled/);
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBeNull();
    });

    it('dims Goal vs Current with the existing reason when the goal is unusable, and still renders the page', async () => {
        const broken = new GoalWorkspace().goal();
        broken.runtimeEdges.push({ from: 'crm-manager', to: 'ghost', via: ['GhostApi'], type: 'rpc' });
        const text = JSON.stringify(broken);
        const workspace = new GoalWorkspace().write(true, text);
        expect(await visualizeRuntime({}, workspace.context)).toEqual({ success: true });
        const html = workspace.out('runtime-architecture.html')!;
        const item = html.match(/<button[^>]*data-wp-mode="goal"[^>]*>[\s\S]*?<\/button>/)![0];
        expect(item).toContain(' disabled aria-disabled="true"');
        expect(item).toContain(`${DEFAULT_RUNTIME_GOAL_PATH}: runtimeEdges[1] (crm-manager -&gt; ghost) names 'ghost'`);
        expect(item).not.toContain('does not exist');
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBe(text);
    });

    it('reports goal level drift read-only, and only --prepare-goal rewrites the derived levels', async () => {
        const stale = new GoalWorkspace().goal();
        stale.services['crm-manager'].level = 1;
        const workspace = new GoalWorkspace().write(true, stale);
        const saved = workspace.read(DEFAULT_RUNTIME_GOAL_PATH);
        expect(await visualizeRuntime({}, workspace.context)).toEqual({ success: true });
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBe(saved);
        expect(logged()).toContain('services["crm-manager"] level: L1 → L2');
        expect(logged()).toContain(RUNTIME_GOAL_PREPARE_COMMAND);
        expect(await visualizeRuntime({ prepareGoal: true }, workspace.context)).toEqual({ success: true });
        const prepared = JSON.parse(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)!) as RuntimeGraph;
        expect(prepared.services['crm-manager'].level).toBe(2);
        expect(prepared.services['billing']).toBeDefined();
        expect(workspace.out('runtime-architecture.html')).toContain('Service billing — added');
    });

    it('lets --prepare-goal compute derived facts a freshly edited goal lacks, after which plain viewing compares it', async () => {
        // A new service with NO level, and a contract-level pubsub edge with no contractQueues entry.
        const text = JSON.stringify(new GoalWorkspace().goal())
            .replace('"services":{', '"services":{"ledger":{"role":"server","implements":["LedgerApi"],"uses":[],"dependsOn":[]},')
            .replace(
            '"runtimeEdges":[',
            '"runtimeEdges":[{"from":"billing","to":"ledger","via":["LedgerApi"],"type":"pubsub"},',
        );
        const workspace = new GoalWorkspace().write(true, text);
        expect(await visualizeRuntime({}, workspace.context)).toEqual({ success: true });
        expect(logged()).toContain('contractQueues["LedgerApi"] is missing.');
        expect(logged()).toContain(RUNTIME_GOAL_PREPARE_COMMAND);
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBe(text);
        expect(await visualizeRuntime({ prepareGoal: true }, workspace.context)).toEqual({ success: true });
        const prepared = JSON.parse(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)!) as RuntimeGraph;
        expect(prepared.services['ledger'].level).toBe(1);
        expect(prepared.contractQueues['LedgerApi'].producedBy).toEqual(['billing']);
        vi.mocked(console.log).mockClear();
        expect(await visualizeRuntime({}, workspace.context)).toEqual({ success: true });
        expect(logged()).toContain('Goal vs Current: ');
        expect(errors()).toBe('');
    });

    it('fails --prepare-goal on a missing goal with its path and how to start one, creating nothing', async () => {
        const workspace = new GoalWorkspace().write(true, null);
        expect(await visualizeRuntime({ prepareGoal: true }, workspace.context)).toEqual({ success: false });
        expect(errors()).toContain(DEFAULT_RUNTIME_GOAL_PATH);
        expect(errors()).toContain(`cp ${CURRENT} ${DEFAULT_RUNTIME_GOAL_PATH}`);
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBeNull();
        expect(workspace.out('runtime-architecture.html')).toBeNull();
    });

    it('leaves no reference to the deleted goal viewer in the package or the repo docs (#1373)', () => {
        const deleted = ['visualize', 'runtime', 'goal'].join('-');
        const packageRoot = path.resolve(__dirname, '../../..');
        const repoRoot = path.resolve(packageRoot, '../../..');
        const files = (dir: string): string[] =>
            fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: fs.Dirent): string[] =>
                entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
            );
        const scanned = [
            ...files(path.join(packageRoot, 'src')),
            path.join(packageRoot, 'README.md'),
            path.join(packageRoot, 'executors.json'),
            ...files(path.join(repoRoot, 'docs')).filter((file: string) => file.endsWith('.md')),
            path.join(repoRoot, 'package.json'),
        ];
        const naming = scanned.filter((file: string) => fs.readFileSync(file, 'utf8').includes(deleted));
        expect(naming).toEqual([]);
        expect(fs.existsSync(path.join(packageRoot, 'src/executors', deleted))).toBe(false);
    });

    it('keeps generation and the current unchanged-check about current facts: an aspirational goal survives both', async () => {
        const workspace = new GoalWorkspace().write();
        const goal = workspace.read(DEFAULT_RUNTIME_GOAL_PATH);
        saveRuntimeGraph(deriveRuntimeGraph(workspace.projects), workspace.root);
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBe(goal);
        expect(await validateRuntime({}, workspace.context)).toEqual({ success: true });
        expect(workspace.read(DEFAULT_RUNTIME_GOAL_PATH)).toBe(goal);
    });
});
