/*
 * The Product color mode's paint, decided IN THE BROWSER from the products switched ON (#1319).
 *
 * Each product's legend row is a toggle. Painting every declared product at once gave a workspace with
 * eight products eight saturated colors plus stripes, which hid exactly what the mode is for: one
 * product's footprint, or where two overlap. So the page keeps an ON set — the first two products in
 * legend (sorted-name) order at EVERY load, never persisted — and repaints from it without
 * regenerating anything: the page already carries each node's products and the ONE palette (#1244).
 *
 * Prepended to graph-visualizer.client.js like graph-mode-state.client.ts. Pure: no DOM, so a spec
 * runs it in a bare VM. The colors it writes are graph-products.ts's (a spec pins that they agree);
 * they are spelled here because this script is not a module and cannot import them.
 */

/** Which of the five looks a Product-mode node gets for one ON set. */
enum WpProductPaintKind {
    /** The node belongs to no product: white, dashed border. */
    NONE = 'none',
    /** Every product it carries is OFF: light grey, still visible. */
    OFF = 'off',
    /** Exactly one of its products is ON: solid in that product's fixed color. */
    SOLID = 'solid',
    /** Two or more of its products are ON: one stripe per ON product. */
    STRIPES = 'stripes',
    /** Every product is ON and the node carries every one: the neutral shared fill. */
    SHARED = 'shared',
}

/** How one node is painted in Product mode. Data-only. */
class WpProductPaint {
    constructor(
        readonly kind: WpProductPaintKind,
        /** SOLID: its one color; STRIPES: one per ON product, in the node's product order; else empty. */
        readonly colors: string[],
        /** The text color that reads on the fill. */
        readonly fontColor: string,
    ) {}
}

/** Decides and writes every Product-mode statement for one ON set. Immutable: a toggle builds a new one. */
class WpProductPainter {
    /** graph-products.ts PRODUCT_SHARED_FILL. */
    static readonly SHARED_FILL = '#c9ced8';
    /** graph-products.ts PRODUCT_NONE_FILL / PRODUCT_NONE_BORDER. */
    static readonly NONE_FILL = '#ffffff';
    static readonly NONE_BORDER = '#8a90a0';
    /** graph-products.ts PRODUCT_OFF_FILL / PRODUCT_OFF_BORDER. */
    static readonly OFF_FILL = '#eef0f4';
    static readonly OFF_BORDER = '#b4b9c4';
    /** graph-color-modes.ts DARK_TEXT / LIGHT_TEXT / STRIPED_CLASS. */
    static readonly DARK_TEXT = '#1a1c22';
    static readonly LIGHT_TEXT = '#ffffff';
    static readonly STRIPED_CLASS = 'wp-striped';
    /** graph-products.ts PRODUCTS_ON_AT_LOAD. */
    static readonly ON_AT_LOAD = 2;

    private readonly colors = new Map<string, ProductColorJson>();

    /**
     * @param legend the products the legend lists, in its order, each with its FIXED palette color —
     *        a color is never reassigned to the ON set, so it always means the same product
     * @param on the products switched ON
     */
    constructor(
        private readonly legend: ProductColorJson[],
        private readonly on: ReadonlySet<string>,
    ) {
        for (const color of legend) this.colors.set(color.product, color);
    }

    /** The ON set every load starts from: the first two products in legend order. */
    static initialOn(order: string[]): Set<string> {
        return new Set(order.slice(0, WpProductPainter.ON_AT_LOAD));
    }

    /** The paint for a node carrying `products`. */
    paint(products: string[]): WpProductPaint {
        if (products.length === 0) return new WpProductPaint(WpProductPaintKind.NONE, [], WpProductPainter.DARK_TEXT);
        const on = products.filter((product: string): boolean => this.isOn(product));
        if (on.length === 0) return new WpProductPaint(WpProductPaintKind.OFF, [], WpProductPainter.DARK_TEXT);
        if (this.allOn() && this.legend.every((color: ProductColorJson): boolean => products.includes(color.product)))
            return new WpProductPaint(WpProductPaintKind.SHARED, [], WpProductPainter.DARK_TEXT);
        const colors = on.map((product: string): ProductColorJson => this.colors.get(product) as ProductColorJson);
        if (colors.length === 1) return new WpProductPaint(WpProductPaintKind.SOLID, [colors[0].color], colors[0].fontColor);
        return new WpProductPaint(
            WpProductPaintKind.STRIPES,
            colors.map((color: ProductColorJson): string => color.color),
            WpProductPainter.DARK_TEXT,
        );
    }

    /**
     * The color a cross-product dependency is dashed in (#1204): the first product it crosses into
     * that is ON; null draws it plain.
     */
    edgeColor(crossesInto: string[]): string | null {
        const into = crossesInto.find((product: string): boolean => this.isOn(product));
        return into === undefined ? null : (this.colors.get(into) as ProductColorJson).color;
    }

    /** A node's Product-mode statement. */
    nodeDot(template: ProductTemplateJson, products: string[]): string {
        const paint = this.paint(products);
        if (template.kind === 'context') return this.context(template.head, paint);
        const label = paint.fontColor === WpProductPainter.LIGHT_TEXT ? template.lightLabel : template.darkLabel;
        return `${template.head}${this.attrs(paint)}, label=<${label}>];\n`;
    }

    /** An edge's Product-mode statement: dashed in its ON target product's color, else plain. */
    edgeDot(edge: RenderEdgeJson): string {
        const color = this.edgeColor(edge.crossesInto);
        if (color === null) return edge.dot;
        return `${edge.dot.slice(0, -2)} [style=dashed, color="${color}", penwidth=2];\n`;
    }

    private isOn(product: string): boolean {
        return this.on.has(product) && this.colors.has(product);
    }

    /** Every product is ON — of a legend listing two or more (a lone product is its own color). */
    private allOn(): boolean {
        return this.legend.length > 1 && this.legend.every((color: ProductColorJson): boolean => this.on.has(color.product));
    }

    private attrs(paint: WpProductPaint): string {
        const dark = WpProductPainter.DARK_TEXT;
        if (paint.kind === WpProductPaintKind.NONE)
            return `style="filled,dashed", fillcolor="${WpProductPainter.NONE_FILL}", fontcolor="${dark}", color="${WpProductPainter.NONE_BORDER}", penwidth=1.5`;
        if (paint.kind === WpProductPaintKind.OFF)
            return `style="filled", fillcolor="${WpProductPainter.OFF_FILL}", fontcolor="${dark}", color="${WpProductPainter.OFF_BORDER}"`;
        if (paint.kind === WpProductPaintKind.SHARED) return `style="filled", fillcolor="${WpProductPainter.SHARED_FILL}", fontcolor="${dark}"`;
        if (paint.kind === WpProductPaintKind.SOLID)
            return `style="filled", fillcolor="${paint.colors[0]}", fontcolor="${paint.fontColor}"`;
        return `${this.stripes(paint.colors)}, fontcolor="${dark}"`;
    }

    /** Equal vertical stripes, the last taking the remainder — the multi-runtime box's renderer. */
    private stripes(colors: string[]): string {
        const share = (1 / colors.length).toFixed(3);
        const weighted = colors.map((color: string, index: number): string =>
            index === colors.length - 1 ? color : `${color};${share}`,
        );
        return `style="striped", fillcolor="${weighted.join(':')}", class="${WpProductPainter.STRIPED_CLASS}"`;
    }

    /**
     * A queue, clock, datastore or vendor keeps its kind statement; only its fill changes. Graphviz
     * cylinders cannot stripe, so several ON products are a gradient; no product is dashed.
     */
    private context(dot: string, paint: WpProductPaint): string {
        const recolored = dot.replace(/fillcolor="[^"]*"/, `fillcolor="${this.contextFill(paint)}"`);
        return paint.kind === WpProductPaintKind.NONE ? recolored.replace(/style="[^"]*"/, 'style="filled,dashed"') : recolored;
    }

    private contextFill(paint: WpProductPaint): string {
        if (paint.kind === WpProductPaintKind.NONE) return WpProductPainter.NONE_FILL;
        if (paint.kind === WpProductPaintKind.OFF) return WpProductPainter.OFF_FILL;
        if (paint.kind === WpProductPaintKind.SHARED) return WpProductPainter.SHARED_FILL;
        return paint.colors.join(':');
    }
}
