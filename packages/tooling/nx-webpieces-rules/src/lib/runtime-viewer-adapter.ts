import type { EnhancedGraph } from './graph-sorter';
import type { RuntimeGraph, RuntimeService } from './runtime-graph-model';
import { GraphRenderModel, RenderNode } from './graph-render-model';
import { NodeFacts, NodeModeDots, NodeModeStyler } from './graph-color-modes';
import { ProductPalette, PRODUCT_SHARED_FILL, PRODUCT_NONE_FILL } from './graph-products';
import { LevelBand } from './graph-level-bands';
import { RemoteServiceNodeId } from './remote-service-node-id';
import { RuntimeExternalTriggers } from './runtime-external-triggers';

/** Saved project facts enrich presentation without changing runtime derivation or topology. */
export class RuntimeViewerAdapter {
    private readonly styler = new NodeModeStyler();
    private readonly palette: ProductPalette;

    constructor(
        private readonly graph: RuntimeGraph,
        private readonly projects: EnhancedGraph | null,
    ) {
        this.palette = new ProductPalette(
            [
                ...new Set(
                    Object.values(graph.services)
                        .filter((service) => service.drawOnGraph !== false)
                        .flatMap((service) => service.products ?? []),
                ),
            ].sort(),
        );
    }

    service(model: GraphRenderModel, name: string, service: RuntimeService): string {
        const project = this.projects?.[name];
        const role = service.role ?? project?.role ?? 'unknown';
        const facts = new NodeFacts(
            name,
            name.split('/').pop() ?? name,
            service.level,
            role,
            project?.framework ?? [],
            service.products ?? [],
            `Implements (${new Set(service.implements).size})${service.serviceName === undefined ? '' : ` · "${service.serviceName}"`}`,
        );
        this.styler.record(model.legend, facts, this.palette);
        return model.styledNode(facts, this.styler.dots(facts, this.palette));
    }

    levelBands(model: GraphRenderModel): LevelBand[] {
        const levels = new Map<string, number>();
        const selfQueues = new Set<string>();
        const safe = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_');
        for (const [name, service] of Object.entries(this.graph.services))
            levels.set(name, service.level);
        for (const node of model.nodes) {
            if (node.queueKeys.length === 0) continue;
            const key = node.queueKeys[0];
            const queue = key.startsWith('queue:')
                ? this.graph.contractQueues[key.slice(6)]
                : this.graph.queues[key];
            levels.set(node.id, queue.level);
            if (queue.selfQueue && queue.producedBy.length > 0) selfQueues.add(node.id);
        }
        for (const [name, system] of Object.entries(this.graph.externalSystems ?? {}))
            levels.set(`system__${safe(name)}`, system.level);
        for (const [name, remote] of Object.entries(this.graph.remoteServices ?? {}))
            levels.set(new RemoteServiceNodeId().of(name), remote.level);
        for (const trigger of this.graph.triggers) {
            if (trigger.kind === 'cron')
                levels.set(`cron__${safe(`${trigger.api}_${trigger.method}`)}`, trigger.level);
        }
        for (const group of new RuntimeExternalTriggers(this.graph.triggers).groups)
            levels.set(group.from, group.triggers[0].level);
        // Undeclared vendor seams are terminal sinks too, independent of their grouping for display.
        for (const use of this.graph.unresolvedUses) {
            const owner = this.graph.apis[use.api]?.owner ?? use.api;
            levels.set(`external__${owner}`, use.level);
        }
        const bands = new Map<number, string[]>();
        for (const node of model.nodes) {
            const level = levels.get(node.id)!;
            if (!bands.has(level)) bands.set(level, []);
            bands.get(level)!.push(node.id);
        }
        return [...bands.entries()]
            .sort((a, b) => b[0] - a[0])
            .map((entry) => {
                const band = new LevelBand(entry[0], entry[1]);
                band.selfQueueNames = entry[1].filter((id) => selfQueues.has(id));
                return band;
            });
    }

    /** Context keeps its shape/kind palette; Impact never paints a queue as a source owner. */
    contextModes(model: GraphRenderModel): void {
        for (let index = 0; index < model.nodes.length; index++) {
            const node = model.nodes[index];
            if (node.tags !== null) continue;
            const colors = node.products.map((product) => this.palette.colorOf(product).color);
            const fill =
                colors.length === 0
                    ? PRODUCT_NONE_FILL
                    : this.palette.sharedByAll(node.products)
                      ? PRODUCT_SHARED_FILL
                      : colors.join(':');
            // Graphviz cylinders cannot stripe; a gradient preserves recognizable kind geometry.
            const recolored = node.dot.replace(/fillcolor="[^"]*"/, `fillcolor="${fill}"`);
            const product =
                colors.length === 0
                    ? recolored.replace(/style="[^"]*"/, 'style="filled,dashed"')
                    : recolored;
            const modes = new NodeModeDots(
                node.dot,
                node.dot,
                node.dot,
                node.dot,
                node.dot,
                node.dot,
                product,
            );
            model.nodes[index] = new RenderNode(
                node.id,
                node.dot,
                modes,
                null,
                node.products,
                node.queueKeys,
            );
        }
    }
}
