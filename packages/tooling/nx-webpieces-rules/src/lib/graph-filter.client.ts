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
        readonly selfQueueNames: string[],
    ) {}
}

/** Original records plus fresh ranks: removed nodes cannot reappear via a rank/edge. */
class WpFilteredDot {
    constructor(private readonly model: RenderModelJson) {}

    /**
     * `nodeDot` picks each box's statement — the architecture page passes its current color mode's —
     * and `edgeDot` each edge's (the Product mode dashes a cross-product dependency).
     * `keepEmptyLevels` keeps a level whose boxes were all filtered out as a thin labeled band, so
     * every remaining box stays in its own L-row (the architecture page); otherwise it is dropped.
     */
    render(
        retained: Set<string>,
        nodeDot: (node: RenderNodeJson) => string = (node: RenderNodeJson): string => node.dot,
        keepEmptyLevels = false,
        edgeDot: (edge: RenderEdgeJson) => string = (edge: RenderEdgeJson): string => edge.dot,
    ): string {
        const nodes = this.model.nodes.filter((node: RenderNodeJson): boolean =>
            retained.has(node.id),
        );
        const edges = this.model.edges.filter(
            (edge: RenderEdgeJson): boolean => retained.has(edge.from) && retained.has(edge.to),
        );
        const bands = this.model.bands
            .map(
                (band: RenderBandJson): WpRenderBand =>
                    new WpRenderBand(
                        band.level,
                        band.nodeNames.filter((id: string): boolean => retained.has(id)),
                        band.selfQueueNames.filter((id: string): boolean => retained.has(id)),
                    ),
            )
            .filter((band: WpRenderBand): boolean => keepEmptyLevels || band.nodeNames.length > 0);
        return (
            this.model.header +
            nodes.map((node: RenderNodeJson): string => nodeDot(node)).join('') +
            this.bandDot(bands) +
            edges.map((edge: RenderEdgeJson): string => edgeDot(edge)).join('') +
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
            dot +=
                band.nodeNames
                    .filter((id) => !band.selfQueueNames.includes(id))
                    .map((id) => `${JSON.stringify(id)}; `)
                    .join('') + '}\n';
            if (band.selfQueueNames.length > 0) {
                const subrow = `${anchor}_selfqueues`;
                dot += `  "${subrow}" ${nodeAttrs};\n  { rank=same; "${subrow}"; `;
                dot += band.selfQueueNames.map((id) => `${JSON.stringify(id)}; `).join('') + '}\n';
                dot += `  "${anchor}" -> "${subrow}" ${edgeAttrs};\n`;
            }
        }
        for (let i = 0; i + 1 < bands.length; i++) {
            const upper = bands[i];
            const lower = bands[i + 1];
            const from = `__wp_layout_L${upper.level}${upper.selfQueueNames.length === 0 ? '' : '_selfqueues'}`;
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

/**
 * Page-owned state survives replacements; rendering failures leave the usable SVG intact.
 *
 * Two independent multi-selects (#1385): `keep` ("Keep connected to") decides which boxes are DRAWN —
 * the union of each pick's complete incoming and outgoing chains, so adding a pick never shrinks the
 * graph — and `focused` ("Focus") decides which drawn boxes are LIT, without a relayout.
 */
abstract class WpFilterPage {
    protected chain: WpGraphChain;
    protected readonly focused = new Set<string>();
    protected keep: ReadonlySet<string> = new Set<string>();
    protected retained: Set<string>;
    private viz: VizInstance | null = null;

    constructor(protected model: RenderModelJson) {
        this.chain = new WpGraphChain(model);
        this.retained = new Set(model.nodes.map((node) => node.id));
    }

    /**
     * Swap the drawn topology — the runtime page's Goal vs Current overlay and its own graph (#1239) —
     * so a mode switch genuinely changes which boxes and arrows exist, and switching back leaves none of
     * the overlay's removed-only boxes behind. A Keep-connected pick the new topology lacks is dropped
     * rather than filtering everything away; a Focus pick survives and relights when its box exists.
     */
    protected useModel(model: RenderModelJson): void {
        if (model === this.model) return;
        this.model = model;
        this.chain = new WpGraphChain(model);
        const ids = new Set(model.nodes.map((node: RenderNodeJson): string => node.id));
        this.retained = new Set(ids);
        this.keep = new Set([...this.keep].filter((id: string): boolean => ids.has(id)));
    }

    render(): void {
        document
            .getElementById('wp-filter-off')
            ?.addEventListener('click', () => this.draw(new Set<string>()));
        this.wireControls();
        Viz.instance()
            .then((viz) => {
                this.viz = viz;
                this.draw(new Set<string>());
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
    /** The statement drawn for one edge. The architecture page answers with its color mode's. */
    protected edgeDot(edge: RenderEdgeJson): string {
        return edge.dot;
    }
    /** Whether an unfiltered draw may use the model's precomputed `fullDot` verbatim. */
    protected usesFullDot(): boolean {
        return true;
    }
    /**
     * The page's own filter on top of "Keep connected to": the architecture page intersects the set
     * with its Filter popover (changes, runtime, role). Everything, by default.
     */
    protected narrow(retained: Set<string>): Set<string> {
        return retained;
    }
    /** Whether a level emptied by filtering stays as a thin labeled band (see WpFilteredDot.render). */
    protected keepsEmptyLevels(): boolean {
        return false;
    }

    /** What "Keep connected to" keeps: the UNION of every pick's complete chains; everything when empty. */
    protected kept(keep: ReadonlySet<string>): Set<string> {
        if (keep.size === 0) return new Set(this.model.nodes.map((node: RenderNodeJson): string => node.id));
        const kept = new Set<string>();
        for (const id of keep) {
            for (const node of this.chain.nodes(id)) kept.add(node);
        }
        return kept;
    }

    /** Draw again with the current picks — after a color-mode or filter change. */
    redraw(): void {
        this.drawKeeping(this.keep);
    }

    /**
     * Draw with a "Keep connected to" set. A control outside the graph (a drawer button, a pulldown's
     * search box) keeps keyboard focus; the redraw would otherwise move it into the graph.
     */
    protected drawKeeping(keep: ReadonlySet<string>): void {
        const active = document.activeElement;
        const host = document.getElementById('graph');
        const outside = active instanceof HTMLElement && host !== null && !host.contains(active);
        this.draw(keep);
        if (outside && active.isConnected) active.focus({ preventScroll: true });
    }

    keepSelection(): ReadonlySet<string> {
        return this.keep;
    }

    /** A box's menu item: "Keep connected" adds the box to Keep connected to; the other removes it. */
    keepItem(name: string): WpNodeMenuItem {
        const kept = this.keep.has(name);
        return new WpNodeMenuItem(kept ? 'Stop keeping connected' : 'Keep connected', () => this.toggleKeep(name));
    }

    toggleKeep(id: string): void {
        const next = new Set(this.keep);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.drawKeeping(next);
    }

    clearKeep(): void {
        if (this.keep.size > 0) this.drawKeeping(new Set<string>());
    }

    draw(keep: ReadonlySet<string>): void {
        if (this.viz === null) return;
        const host = document.getElementById('graph');
        if (host === null) return;
        const retained = this.narrow(this.kept(keep));
        const previousKeep = this.keep;
        const previousRetained = this.retained;
        const previousSvg = host.querySelector('svg');
        const focusName = WpNodeMenu.focusedName(previousSvg);
        const rollback = this.captureBinding(previousSvg);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- browser transaction restores the previous usable graph on failure
        try {
            const dot =
                keep.size === 0 && this.usesFullDot()
                    ? this.model.fullDot
                    : new WpFilteredDot(this.model).render(
                          retained,
                          (node: RenderNodeJson): string => this.nodeDot(node),
                          this.keepsEmptyLevels(),
                          (edge: RenderEdgeJson): string => this.edgeDot(edge),
                      );
            const svg = this.viz.renderSVGElement(dot);
            this.prepareSvg(svg);
            WpNodeMenu.close();
            this.keep = keep;
            this.retained = retained;
            host.replaceChildren(svg);
            this.wireSvg(svg);
            this.indicator();
            WpNodeMenu.restoreFocus(svg, focusName);
            this.error(null);
            // webpieces-disable no-any-unknown -- JavaScript may throw any value at this browser boundary
        } catch (err: unknown) {
            //const error = toError(err);
            this.keep = previousKeep;
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
        if (status !== null) status.hidden = this.keep.size === 0;
        if (label !== null) label.textContent = [...this.keep].sort((a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase())).join(', ');
        if (this.keep.size > 0) document.getElementById('wp-filter-off')?.focus();
        else document.querySelector<SVGGElement>('#graph g.wp-node-clickable')?.focus();
    }

    private error(err: Error | null): void {
        const el = document.getElementById('wp-graph-error');
        if (el === null) return;
        el.hidden = err === null;
        el.textContent =
            err === null
                ? ''
                : `Graph rendering failed: ${err.message}. Try Clear all in Keep connected to, or reload the page.`;
    }
}
