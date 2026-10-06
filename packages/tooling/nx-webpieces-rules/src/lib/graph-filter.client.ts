/** Plain browser helpers shared by architecture and runtime; no CommonJS imports. */
class WpGraphChain {
    readonly inNodes = new Map<string, Set<string>>();
    readonly outNodes = new Map<string, Set<string>>();

    constructor(private readonly model: RenderModelJson) {
        const ids = new Set(model.nodes.map((node) => node.id));
        for (const edge of model.edges) {
            if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
            this.add(this.outNodes, edge.from, edge.to);
            this.add(this.inNodes, edge.to, edge.from);
        }
    }

    private add(map: Map<string, Set<string>>, from: string, to: string): void {
        if (!map.has(from)) map.set(from, new Set());
        map.get(from)?.add(to);
    }

    nodes(anchor: string): Set<string> {
        const retained = new Set<string>();
        if (!this.model.nodes.some((node) => node.id === anchor)) return retained;
        for (const direction of [this.inNodes, this.outNodes]) {
            const visited = new Set([anchor]);
            const stack = [anchor];
            while (stack.length > 0) {
                const id = stack.pop() as string;
                retained.add(id);
                for (const next of direction.get(id) ?? []) {
                    if (visited.has(next)) continue;
                    visited.add(next);
                    stack.push(next);
                }
            }
        }
        return retained;
    }
}

class WpRenderBand {
    constructor(
        readonly level: number,
        readonly nodeNames: string[],
    ) {}
}

/** Original records plus fresh ranks: removed nodes cannot reappear via a rank/edge. */
class WpFilteredDot {
    constructor(private readonly model: RenderModelJson) {}

    /**
     * `nodeDot` picks each box's statement — the architecture page passes its current color mode's.
     * `keepEmptyLevels` keeps a level whose boxes were all filtered out as a thin labeled band, so
     * every remaining box stays in its own L-row (the architecture page); otherwise it is dropped.
     */
    render(
        retained: Set<string>,
        nodeDot: (node: RenderNodeJson) => string = (node: RenderNodeJson): string => node.dot,
        keepEmptyLevels = false,
    ): string {
        const nodes = this.model.nodes.filter((node: RenderNodeJson): boolean => retained.has(node.id));
        const edges = this.model.edges.filter(
            (edge: RenderEdgeJson): boolean => retained.has(edge.from) && retained.has(edge.to),
        );
        const bands = this.model.bands
            .map(
                (band: RenderBandJson): WpRenderBand =>
                    new WpRenderBand(
                        band.level,
                        band.nodeNames.filter((id: string): boolean => retained.has(id)),
                    ),
            )
            .filter((band: WpRenderBand): boolean => keepEmptyLevels || band.nodeNames.length > 0);
        return (
            this.model.header +
            nodes.map((node: RenderNodeJson): string => nodeDot(node)).join('') +
            this.bandDot(bands) +
            edges.map((edge) => edge.dot).join('') +
            this.model.footer
        );
    }

    private bandDot(bands: WpRenderBand[]): string {
        const nodeAttrs =
            '[style=invis, shape=point, width=0.01, height=0.01, label="", class="wp-layout"]';
        const edgeAttrs = '[style=invis, class="wp-layout"]';
        let dot = '';
        for (const band of bands) {
            const anchor = `__wp_layout_L${band.level}`;
            // The same bytes as LevelBandLayout.emptyBandAttrs (graph-level-bands.ts).
            const attrs =
                band.nodeNames.length > 0
                    ? nodeAttrs
                    : '[shape=plaintext, style="", width=0.01, height=0.15, margin=0, fontsize=9, fontcolor="#9a9eab", ' +
                      `label="L${band.level} · no matching projects", class="wp-layout wp-empty-level"]`;
            dot += `  "${anchor}" ${attrs};\n  { rank=same; "${anchor}"; `;
            dot += band.nodeNames.map((id) => `${JSON.stringify(id)}; `).join('') + '}\n';
        }
        for (let i = 0; i + 1 < bands.length; i++) {
            const upper = bands[i];
            const lower = bands[i + 1];
            const from = `__wp_layout_L${upper.level}`;
            const to = `__wp_layout_L${lower.level}`;
            if (upper.nodeNames.length <= 10 && lower.nodeNames.length <= 10) {
                dot += `  "${from}" -> "${to}" ${edgeAttrs};\n`;
                continue;
            }
            const spacer = `__wp_layout_spacer_L${upper.level}_L${lower.level}`;
            dot += `  "${spacer}" ${nodeAttrs};\n  { rank=same; "${spacer}"; }\n`;
            dot += `  "${from}" -> "${spacer}" ${edgeAttrs};\n  "${spacer}" -> "${to}" ${edgeAttrs};\n`;
        }
        return dot;
    }
}

/** Page-owned state survives replacements; rendering failures leave the usable SVG intact. */
abstract class WpFilterPage {
    protected readonly chain: WpGraphChain;
    protected locked: string | null = null;
    protected anchor: string | null = null;
    protected retained: Set<string>;
    private viz: VizInstance | null = null;

    constructor(protected readonly model: RenderModelJson) {
        this.chain = new WpGraphChain(model);
        this.retained = new Set(model.nodes.map((node) => node.id));
    }

    render(): void {
        document
            .getElementById('wp-filter-off')
            ?.addEventListener('click', () => this.filter(null));
        this.wireControls();
        Viz.instance()
            .then((viz) => {
                this.viz = viz;
                this.filter(null);
            })
            // webpieces-disable no-any-unknown -- promise rejections may carry any JavaScript value
            .catch((err: unknown): void =>
                this.error(err instanceof Error ? err : new Error(String(err))),
            );
    }

    protected captureBinding(_svg: SVGSVGElement | null): () => void {
        return (): void => {};
    }
    protected wireControls(): void {}
    protected abstract wireSvg(svg: SVGSVGElement): void;
    protected prepareSvg(_svg: SVGSVGElement): void {}
    /** The statement drawn for one box. The architecture page answers with its color mode's. */
    protected nodeDot(node: RenderNodeJson): string {
        return node.dot;
    }
    /** Whether an unfiltered draw may use the model's precomputed `fullDot` verbatim. */
    protected usesFullDot(): boolean {
        return true;
    }
    /**
     * The page's own filter on top of "Hide unconnected": the architecture page intersects the set
     * with its Filter popover (changes, runtime, role). Everything, by default.
     */
    protected narrow(retained: Set<string>): Set<string> {
        return retained;
    }
    /** Whether a level emptied by filtering stays as a thin labeled band (see WpFilteredDot.render). */
    protected keepsEmptyLevels(): boolean {
        return false;
    }

    /**
     * Draw again with the current filter — after a color-mode switch. A control outside the graph
     * (a drawer button) keeps keyboard focus; the redraw would otherwise move it into the graph.
     */
    redraw(): void {
        const active = document.activeElement;
        const host = document.getElementById('graph');
        const outside = active instanceof HTMLElement && host !== null && !host.contains(active);
        this.filter(this.anchor);
        if (outside && active.isConnected) active.focus({ preventScroll: true });
    }

    filterItem(name: string): WpNodeMenuItem {
        return new WpNodeMenuItem(
            this.anchor === null ? 'Filter Unconnected' : 'Turn off Filter',
            () => this.filter(this.anchor === null ? name : null),
        );
    }

    filter(anchor: string | null): void {
        if (this.viz === null) return;
        const host = document.getElementById('graph');
        if (host === null) return;
        const retained = this.narrow(
            anchor === null
                ? new Set(this.model.nodes.map((node: RenderNodeJson): string => node.id))
                : this.chain.nodes(anchor),
        );
        const previousAnchor = this.anchor;
        const previousRetained = this.retained;
        const previousSvg = host.querySelector('svg');
        const focusName = WpNodeMenu.focusedName(previousSvg);
        const rollback = this.captureBinding(previousSvg);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- browser transaction restores the previous usable graph on failure
        try {
            const dot =
                anchor === null && this.usesFullDot()
                    ? this.model.fullDot
                    : new WpFilteredDot(this.model).render(
                          retained,
                          (node: RenderNodeJson): string => this.nodeDot(node),
                          this.keepsEmptyLevels(),
                      );
            const svg = this.viz.renderSVGElement(dot);
            this.prepareSvg(svg);
            WpNodeMenu.close();
            this.anchor = anchor;
            this.retained = retained;
            host.replaceChildren(svg);
            this.wireSvg(svg);
            this.indicator();
            WpNodeMenu.restoreFocus(svg, focusName);
            this.error(null);
            // webpieces-disable no-any-unknown -- JavaScript may throw any value at this browser boundary
        } catch (err: unknown) {
            //const error = toError(err);
            this.anchor = previousAnchor;
            this.retained = previousRetained;
            if (previousSvg !== null) host.replaceChildren(previousSvg);
            else host.replaceChildren();
            rollback();
            if (previousSvg !== null) WpNodeMenu.restoreFocus(previousSvg, focusName);
            this.error(err instanceof Error ? err : new Error(String(err)));
        }
    }

    private indicator(): void {
        const status = document.getElementById('wp-filter-status');
        const label = document.getElementById('wp-filter-anchor');
        if (status !== null) status.hidden = this.anchor === null;
        if (label !== null) label.textContent = this.anchor;
        if (this.anchor !== null) document.getElementById('wp-filter-off')?.focus();
        else document.querySelector<SVGGElement>('#graph g.wp-node-clickable')?.focus();
    }

    private error(err: Error | null): void {
        const el = document.getElementById('wp-graph-error');
        if (el === null) return;
        el.hidden = err === null;
        el.textContent =
            err === null
                ? ''
                : `Graph rendering failed: ${err.message}. Try Turn off Filter or reload the page.`;
    }
}
