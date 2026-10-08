import type { EnhancedGraph } from './graph-sorter';
import type { RuntimeGraph, RuntimeService } from './runtime-graph-model';
import { GraphRenderModel, RenderNode } from './graph-render-model';
import { NodeFacts, NodeModeDots, NodeModeStyler } from './graph-color-modes';
import { ProductPalette, PRODUCT_SHARED_FILL, PRODUCT_NONE_FILL } from './graph-products';

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
            `Implements (${service.implements.length})${service.serviceName === undefined ? '' : ` · "${service.serviceName}"`}`,
        );
        this.styler.record(model.legend, facts, this.palette);
        return model.styledNode(facts, this.styler.dots(facts, this.palette));
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
