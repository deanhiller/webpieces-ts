import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { GraphVisualizer } from '../graph-visualizer';
import { GraphRenderModel } from '../graph-render-model';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph } from '../runtime-graph';

interface ChainReader {
    nodes(anchor: string): Set<string>;
}
interface DotReader {
    render(retained: Set<string>): string;
}
interface FilterApi {
    chain(model: GraphRenderModel): ChainReader;
    dot(model: GraphRenderModel): DotReader;
}

export class FilterFixture {
    static client(name: string): string {
        return ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
    }

    static api(): FilterApi {
        return vm.runInNewContext(
            FilterFixture.client('graph-filter.client.ts') +
                `\n({
            chain: model => new WpGraphChain(model), dot: model => new WpFilteredDot(model)
        })`,
        ) as FilterApi;
    }

    static visualizer(): GraphVisualizer {
        return new GraphVisualizer(
            () => FilterFixture.client('graph-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
        );
    }

    static wide(): EnhancedGraph {
        const graph: EnhancedGraph = {
            'webpieces-tooling': {
                level: 5,
                dependsOn: ['ai-hook-rules', 'agent-workflow-rules', 'pr-gate'],
            },
            'ai-hook-rules': { level: 4, dependsOn: ['hook-runtime'] },
            'agent-workflow-rules': { level: 4, dependsOn: ['hook-runtime'] },
            'pr-gate': { level: 4, dependsOn: ['hook-runtime'] },
            'hook-runtime': { level: 3, dependsOn: ['rules-config'] },
            'rules-config': { level: 2, dependsOn: ['repo-workflow-core'] },
            'repo-workflow-core': { level: 1, dependsOn: ['tooling-common'] },
            'tooling-common': { level: 0, dependsOn: [] },
            'nx-webpieces-rules': { level: 4, dependsOn: ['tooling-common'] },
            'code-rules': { level: 4, dependsOn: ['tooling-common'] },
            'eslint-rules': { level: 4, dependsOn: ['tooling-common'] },
            'core-mock': { level: 0, dependsOn: [] },
        };
        for (let i = 0; i < 16; i++) graph[`unrelated-${i}`] = { level: 4, dependsOn: [] };
        return graph;
    }

    static runtime(): RuntimeGraph {
        const service = { level: 0, implements: [], uses: [], dependsOn: [] };
        return {
            services: {
                producer: service,
                consumer: service,
                unrelated: service,
                hidden: { ...service, drawOnGraph: false },
            },
            apis: {
                ExternalApi: { implementedBy: [], usedBy: ['consumer'], owner: '@vendor/api' },
            },
            queues: {
                'TaskApi.send': {
                    api: 'TaskApi',
                    method: 'send',
                    queueName: 'TaskApi-send',
                    producedBy: ['producer'],
                    consumedBy: ['consumer'],
                },
            },
            runtimeEdges: [
                {
                    from: 'producer',
                    to: 'consumer',
                    via: ['TaskApi'],
                    type: 'pubsub',
                    queue: 'TaskApi.send',
                },
                { from: 'producer', to: 'hidden', via: ['HiddenApi'] },
                { from: 'hidden', to: 'unrelated', via: ['HiddenApi'] },
            ],
            triggers: [{ kind: 'cron', service: 'producer', api: 'SweepApi', method: 'run' }],
            unresolvedUses: [{ service: 'consumer', api: 'ExternalApi' }],
            externalSystems: {
                db: { kind: 'database', label: 'db', apis: ['DatabaseApi'], usedBy: ['consumer'] },
            },
        };
    }
}
