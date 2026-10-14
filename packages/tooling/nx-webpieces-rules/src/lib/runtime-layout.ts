import { GraphRenderModel, RenderEdge } from './graph-render-model';
import { LevelBandLayout } from './graph-level-bands';

/** Saved levels own layout; real feedback arrows remain visible without moving ranks. */
export class RuntimeLayout {
    render(model: GraphRenderModel): string {
        const levels = new Map<string, number>();
        for (const band of model.bands) {
            for (const name of band.nodeNames) levels.set(name, band.level);
        }
        for (let index = 0; index < model.edges.length; index++) {
            const edge = model.edges[index];
            if (levels.get(edge.from)! > levels.get(edge.to)!) continue;
            model.edges[index] = new RenderEdge(
                edge.from,
                edge.to,
                this.unconstrained(edge.dot),
                edge.id,
                edge.productDot === null ? null : this.unconstrained(edge.productDot),
            );
        }
        return this.assemble(model);
    }

    /** The DOT for the model's current statements, without re-deciding constraints (restyled overlays). */
    assemble(model: GraphRenderModel): string {
        return (
            model.header +
            model.nodes.map((node) => node.dot).join('') +
            new LevelBandLayout().dot(model.bands) +
            model.edges.map((edge) => edge.dot).join('') +
            model.footer
        );
    }

    private unconstrained(dot: string): string {
        return `${dot.slice(0, -2)} [constraint=false];\n`;
    }
}
