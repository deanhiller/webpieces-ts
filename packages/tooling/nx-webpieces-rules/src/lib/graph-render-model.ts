import { dotValue } from './dot-syntax';
import { LevelBand } from './graph-level-bands';
import { LegendFacts, NodeModeDots } from './graph-color-modes';

/**
 * Renderer-owned records, captured while emitting DOT, never recovered by parsing labels.
 *
 * `dot` is the statement `fullDot` carries. `modes` is set only by the architecture graph, whose page
 * switches color modes by re-rendering each box from its per-mode statement; the runtime graph has
 * one look and leaves it null.
 */
export class RenderNode {
    constructor(
        public readonly id: string,
        public readonly dot: string,
        public readonly modes: NodeModeDots | null,
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

    node(id: string, dot: string): string {
        this.nodes.push(new RenderNode(id, dot, null));
        return dot;
    }

    /** A box drawn differently per color mode; `fullDot` carries its RUNTIME statement. */
    styledNode(id: string, modes: NodeModeDots): string {
        this.nodes.push(new RenderNode(id, modes.runtime, modes));
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
