import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { GraphVisualizer } from '../graph-visualizer';
import { GraphRenderModel, RenderEdge } from '../graph-render-model';
import type { ProductColor, ProductTemplate } from '../graph-products';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph } from '../runtime-graph';

interface ChainReader {
    nodes(anchor: string): Set<string>;
}
interface DotReader {
    render(
        retained: Set<string>,
        nodeDot?: (node: RenderNodeShape) => string,
        keepEmptyLevels?: boolean,
        edgeDot?: (edge: RenderEdgeShape) => string,
    ): string;
}
interface RenderNodeShape {
    dot: string;
}
interface RenderEdgeShape {
    dot: string;
    crossesInto: string[];
}
/** WpProductPaint (graph-product-paint.client.ts), as the VM returns it. */
export interface ProductPaintShape {
    kind: string;
    colors: string[];
    fontColor: string;
}
/** WpProductPainter (graph-product-paint.client.ts), run from the shipped client source. */
export interface ProductPainterShape {
    paint(products: string[]): ProductPaintShape;
    edgeColor(crossesInto: string[]): string | null;
    nodeDot(template: ProductTemplate, products: string[]): string;
    edgeDot(edge: RenderEdge): string;
}
interface ProductPaintApi {
    painter(legend: ProductColor[], on: string[]): ProductPainterShape;
    initialOn(order: string[]): string[];
    constants: Record<string, string | number>;
}
interface FilterApi {
    chain(model: GraphRenderModel): ChainReader;
    dot(model: GraphRenderModel): DotReader;
}

export class FilterFixture {
    static client(name: string): string {
        const prefix =
            name === 'graph-visualizer.client.ts'
                ? FilterFixture.client('graph-mode-state.client.ts') + FilterFixture.client('graph-product-paint.client.ts')
                : '';
        return prefix + ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), {
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

    /** The page's Product-mode painter (#1319), from the shipped client source in a bare VM. */
    static productPaint(): ProductPaintApi {
        return vm.runInNewContext(
            FilterFixture.client('graph-product-paint.client.ts') +
                `\n({
            painter: (legend, on) => new WpProductPainter(JSON.parse(JSON.stringify(legend)), new Set(on)),
            initialOn: order => [...WpProductPainter.initialOn(order)],
            constants: {
                SHARED_FILL: WpProductPainter.SHARED_FILL, NONE_FILL: WpProductPainter.NONE_FILL,
                NONE_BORDER: WpProductPainter.NONE_BORDER, OFF_FILL: WpProductPainter.OFF_FILL,
                OFF_BORDER: WpProductPainter.OFF_BORDER, DARK_TEXT: WpProductPainter.DARK_TEXT,
                LIGHT_TEXT: WpProductPainter.LIGHT_TEXT, STRIPED_CLASS: WpProductPainter.STRIPED_CLASS,
                ON_AT_LOAD: WpProductPainter.ON_AT_LOAD,
            },
        })`,
        ) as ProductPaintApi;
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
