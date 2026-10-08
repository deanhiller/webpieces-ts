import { dotValue } from './dot-syntax';
import { LevelBand } from './graph-level-bands';
import { LegendFacts, NodeFacts, NodeModeDots } from './graph-color-modes';

/**
 * Renderer-owned records, captured while emitting DOT, never recovered by parsing labels.
 *
 * `dot` is the statement `fullDot` carries. `modes` and `tags` are set only by the architecture
 * graph, whose page switches color modes by re-rendering each box from its per-mode statement and
 * filters boxes by their role and framework tags; the runtime graph has one look and leaves both null.
 *
 * `products` is set on BOTH graphs (#1179): the products a box belongs to, which each page's product
 * filter matches on. Empty for a box in no product.
 */
export class RenderNode {
    constructor(
        public readonly id: string,
        public readonly dot: string,
        public readonly modes: NodeModeDots | null,
        public readonly tags: NodeTags | null,
        public readonly products: string[],
    ) {}
}

/** What the architecture page's Filter matches a box on: its level, role and framework tags. */
export class NodeTags {
    constructor(
        public readonly level: number,
        public readonly role: string,
        public readonly frameworks: string[],
    ) {}
}

export class RenderEdge {
    constructor(
        public readonly from: string,
        public readonly to: string,
        public readonly dot: string,
        public readonly id: string,
    ) {}
}

/** The immutable drawable snapshot carried by a generated page. */
export class GraphRenderModel {
    readonly nodes: RenderNode[] = [];
    readonly edges: RenderEdge[] = [];
    bands: LevelBand[] = [];
    fullDot = '';
    header = '';
    footer = '';
    /** The colors and roles in use, so the page's legend lists exactly those (architecture graph). */
    legend = new LegendFacts();

    node(id: string, dot: string, products: string[] = []): string {
        this.nodes.push(new RenderNode(id, dot, null, null, products));
        return dot;
    }

    /**
     * Every product a declared box (a queue, a cron trigger, an external system) inherits from the
     * services its edges touch (#1179): it belongs to whichever product's services it is attached to.
     * Called by the runtime graph once every edge is emitted; RenderNode is immutable, so a node gains
     * its products by being replaced.
     */
    attachProducts(isService: (id: string) => boolean): void {
        const byId = new Map<string, RenderNode>();
        for (const node of this.nodes) byId.set(node.id, node);
        for (let index = 0; index < this.nodes.length; index++) {
            const node = this.nodes[index];
            if (isService(node.id)) continue;
            const inherited = new Set<string>();
            for (const edge of this.edges) {
                const other = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : null;
                if (other === null || !isService(other)) continue;
                for (const product of byId.get(other)?.products ?? []) inherited.add(product);
            }
            if (inherited.size === 0) continue;
            this.nodes[index] = new RenderNode(node.id, node.dot, node.modes, node.tags, [...inherited].sort());
        }
    }

    /** A box drawn differently per color mode; `fullDot` carries its RUNTIME statement. */
    styledNode(facts: NodeFacts, modes: NodeModeDots): string {
        this.nodes.push(
            new RenderNode(
                facts.nodeId,
                modes.runtime,
                modes,
                new NodeTags(facts.level, facts.role, facts.frameworks),
                facts.products,
            ),
        );
        return modes.runtime;
    }

    completeEndpoints(): void {
        const ids = new Set(this.nodes.map((node) => node.id));
        for (const edge of this.edges) {
            for (const id of [edge.from, edge.to]) {
                if (ids.has(id)) continue;
                ids.add(id);
                this.node(id, `  "${dotValue(id)}";\n`);
            }
        }
    }

    edge(from: string, to: string, dot: string): string {
        const id = `wp-real-edge-${this.edges.length}`;
        const statement = `${dot.slice(0, -2)} [id="${id}"];\n`;
        this.edges.push(new RenderEdge(from, to, statement, id));
        return statement;
    }
}

/** Shared filter chrome and script-safe JSON for pages opened directly from disk. */
export class GraphFilterAssets {
    json<T>(value: T): string {
        return JSON.stringify(value).replace(/</g, '\\u003c');
    }

    html(): string {
        return (
            '<p id="wp-filter-status" hidden>Filtering: <strong id="wp-filter-anchor"></strong> ' +
            '<button id="wp-filter-off" type="button">Turn off Filter</button></p>' +
            '<p id="wp-graph-error" role="alert" hidden></p>'
        );
    }

    styles(): string {
        return (
            '#wp-filter-status { text-align:center; } #wp-graph-error { color:#b71c1c; } ' +
            '#graph .wp-filter-anchor polygon, #graph .wp-filter-anchor path, ' +
            '#graph .wp-filter-anchor ellipse { stroke:#1565c0; stroke-width:3; }'
        );
    }
}
