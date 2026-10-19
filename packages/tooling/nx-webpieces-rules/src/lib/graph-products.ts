/**
 * Products on the architecture graphs (#1179).
 *
 * A monorepo can hold several PRODUCTS, each with its own clients and servers. A project declares the
 * products it belongs to with the nx tag `product:<name>` (product-resolver.ts). Membership is TAGS
 * ONLY (#1216) on both graphs — nothing is inherited over an edge:
 *
 *  - ProductMembership — the dependency graph. A project's products are exactly its own declared
 *    `product:` tags. An UNTAGGED project is in no product, however many tagged projects depend on it,
 *    and renders as "no product" — a box that still needs a tag. A consumer that wants every project
 *    assigned lists the library roles in `product-tags.roles`, so an untagged library fails generation
 *    instead of quietly sitting outside every product (and outside the product dependency matrix,
 *    which skips any edge with an untagged end — product-dependencies.ts).
 *  - RuntimeProductMembership — the runtime graph. A service's products are exactly its project's
 *    declared `product:` tags. A service is never put in a product because another service calls it or
 *    feeds its queue; a call from one product into another product's service shows as the runtime EDGE
 *    between them. A service whose project carries no tag is in no product.
 *  - ProductPalette — the Product color mode's colors (#1244): eight fixed saturated colors, each
 *    product hashed (SHA-256 of its name) to a preferred one, with collisions resolved in sorted-name
 *    order. Both viewers build it over the FULL declared product set, so they agree, and a color is
 *    never reassigned when a product is toggled OFF.
 *  - ProductTemplate — what a page needs to paint one box in the Product color mode (#1319). Each
 *    product's legend row is a toggle and the page repaints in the browser from the ON set
 *    (WpProductPainter, graph-product-paint.client.ts), so the box's product statement is computed
 *    there, not here.
 *  - ProductBoundary — which dependency edges cross from one product into another (#1204), drawn
 *    dashed in the target product's color in the Product color mode while that product is ON.
 *
 * Membership is stable per checkout (it depends on tags only, never on a diff), so it is written into
 * the committed dependencies.json / runtime-dependencies.json rather than into a sidecar.
 */

import { createHash } from 'node:crypto';
import type { EnhancedGraph } from './graph-sorter';
import type { RuntimeGraph } from './runtime-graph-model';

// The same two text colors graph-color-modes.ts writes on every fill. Spelled here rather than
// imported because graph-color-modes.ts imports THIS file (for the palette), and a file-import cycle
// is refused by `no-file-import-cycles`.
const DARK_TEXT = '#1a1c22';
const LIGHT_TEXT = '#ffffff';

/** One product's color, and the text color that reads on it. Data-only. */
export class ProductColor {
    constructor(
        public readonly product: string,
        public readonly color: string,
        public readonly fontColor: string,
    ) {}
}

/** One of the palette's eight colors, and the text color that reads on it. Data-only. */
export class ProductPaletteSlot {
    constructor(
        public readonly color: string,
        public readonly fontColor: string,
    ) {}
}

/** The eight product colors, indexed by slot. Distinct from every runtime and role color. */
export const PRODUCT_PALETTE_SLOTS: readonly ProductPaletteSlot[] = [
    new ProductPaletteSlot('#3f6fb5', LIGHT_TEXT),
    new ProductPaletteSlot('#f28e2b', DARK_TEXT),
    new ProductPaletteSlot('#c0392b', LIGHT_TEXT),
    new ProductPaletteSlot('#5cb8b2', DARK_TEXT),
    new ProductPaletteSlot('#3d8b3d', LIGHT_TEXT),
    new ProductPaletteSlot('#edc948', DARK_TEXT),
    new ProductPaletteSlot('#8e5ea2', LIGHT_TEXT),
    new ProductPaletteSlot('#ff9da7', DARK_TEXT),
];

/** A box shared by EVERY product, drawn neutral only while every product is ON (#1319). */
export const PRODUCT_SHARED_FILL = '#c9ced8';
/** A box in no product: white, with a dashed border. */
export const PRODUCT_NONE_FILL = '#ffffff';
export const PRODUCT_NONE_BORDER = '#8a90a0';
/**
 * A box carrying only products switched OFF (#1319): light grey with a grey border, so it stays
 * visible — hiding boxes is the Filter's job — and never reads as the neutral shared fill.
 */
export const PRODUCT_OFF_FILL = '#eef0f4';
export const PRODUCT_OFF_BORDER = '#b4b9c4';

/**
 * How many products are ON when a page loads (#1319): the first ones in legend (sorted-name) order.
 * Always this many, on every load — the selection is never persisted.
 */
export const PRODUCTS_ON_AT_LOAD = 2;

/** Whether a ProductTemplate paints a styled box or restyles a contextual node's kind statement. */
export enum ProductTemplateKind {
    /** A project or service box: the page writes its whole statement. */
    BOX = 'box',
    /** A runtime queue, clock, datastore or vendor: the page recolors its kind statement's fill. */
    CONTEXT = 'context',
}

/**
 * What the page needs to write one node's Product-mode statement for any ON set (#1319). Data-only.
 * A BOX statement is `head` + the paint's attributes + the label for its text color; a CONTEXT
 * statement is `head` (the kind statement) with its fill replaced.
 */
export class ProductTemplate {
    constructor(
        public readonly kind: ProductTemplateKind,
        /** BOX: `  "id" [`. CONTEXT: the node's whole kind statement. */
        public readonly head: string,
        /** BOX: the HTML label written in dark text; '' for CONTEXT. */
        public readonly darkLabel: string,
        /** BOX: the HTML label written in light text; '' for CONTEXT. */
        public readonly lightLabel: string,
    ) {}
}

export class ProductPalette {
    /** Every declared product, sorted, each with its color. */
    readonly colors: ProductColor[];

    /**
     * @param products the FULL declared product set. Collision resolution depends on the set, so a
     *        viewer showing a subset must still pass every declared product, or its colors would
     *        disagree with the other viewer's.
     */
    constructor(products: readonly string[]) {
        const sorted = [...new Set(products)].sort();
        const taken = new Set<number>();
        this.colors = sorted.map((product: string): ProductColor => {
            const slot = this.freeSlot(this.preferredSlot(product), taken);
            taken.add(slot);
            return this.paint(product, slot);
        });
    }

    /** The slot a product's name hashes to: SHA-256 of the name, first byte, mod the palette size. */
    preferredSlot(product: string): number {
        return createHash('sha256').update(product, 'utf8').digest()[0] % PRODUCT_PALETTE_SLOTS.length;
    }

    /** The preferred slot when free, else the next free one (wrapping); with all taken, the preferred one. */
    private freeSlot(preferred: number, taken: ReadonlySet<number>): number {
        for (let step = 0; step < PRODUCT_PALETTE_SLOTS.length; step++) {
            const slot = (preferred + step) % PRODUCT_PALETTE_SLOTS.length;
            if (!taken.has(slot)) return slot;
        }
        return preferred;
    }

    private paint(product: string, slot: number): ProductColor {
        const entry = PRODUCT_PALETTE_SLOTS[slot];
        return new ProductColor(product, entry.color, entry.fontColor);
    }

    /** Every product carried by a project of the graph, as one palette. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromGraph(graph: EnhancedGraph): ProductPalette {
        const all: string[] = [];
        for (const entry of Object.values(graph)) all.push(...(entry.products ?? []));
        return new ProductPalette(all);
    }

    names(): string[] {
        return this.colors.map((color: ProductColor): string => color.product);
    }

    colorOf(product: string): ProductColor {
        // The assignment contract (#1244): the slot SHA-256 of the name prefers, with collisions
        // resolved in sorted-name order over the whole set — the earlier name keeps a contested slot,
        // the later takes the next free one. So adding a product recolors nobody unless it hashes onto
        // a taken slot AND sorts before its holder. Never assign by sorted index: every addition would
        // shift every later product. A product outside the set gets its preferred slot.
        return (
            this.colors.find((color: ProductColor): boolean => color.product === product) ??
            this.paint(product, this.preferredSlot(product))
        );
    }

    /** True for a box carrying every product of a workspace that declares two or more. */
    sharedByAll(products: readonly string[]): boolean {
        return this.colors.length > 1 && this.colors.every((color: ProductColor): boolean => products.includes(color.product));
    }
}

/**
 * Where a dependency edge crosses a product boundary (#1204), for the Product color mode: an edge
 * A -> B crosses when B does not carry every product of A, and it is drawn dashed in the color of the
 * product it crosses INTO, so the boundaries read at a glance while same-product edges stay quiet.
 * Since #1319 that is the first of those products that is ON; with none ON the edge draws plain.
 * Whether a crossing is ALLOWED is the product dependency matrix's call (product-dependencies.ts):
 * with `product-tags` ON, generation already refused every crossing the matrix does not allow, so
 * every crossing drawn is an allowed one.
 */
export class ProductBoundary {
    /**
     * The products the edge crosses into, in the target's order: the target's products its source
     * lacks, else (a target narrower than its source) every product of the target. Empty when the
     * target carries every product of the source. The page draws the edge in the first one that is ON.
     */
    crossedInto(from: readonly string[], to: readonly string[]): string[] {
        if (from.length === 0 || to.length === 0) return [];
        if (from.every((product: string): boolean => to.includes(product))) return [];
        const added = to.filter((product: string): boolean => !from.includes(product));
        return added.length > 0 ? added : [...to];
    }
}

/**
 * The architecture graph's product membership: exactly each project's declared `product:` tags (#1216).
 */
export class ProductMembership {
    /**
     * @param seeds project → the products it DECLARES (its `product:` tags)
     * @returns project → its sorted declared products. An untagged project is absent — it is in no
     *          product, however many tagged projects depend on it — so with no tag anywhere the map is
     *          empty.
     */
    compute(seeds: ReadonlyMap<string, readonly string[]>, graph: EnhancedGraph): Map<string, string[]> {
        const result = new Map<string, string[]>();
        seeds.forEach((products: readonly string[], project: string): void => {
            if (products.length > 0 && graph[project] !== undefined) result.set(project, [...new Set(products)].sort());
        });
        return result;
    }
}

/**
 * The runtime graph's product membership: exactly each service's project's declared `product:` tags
 * (#1216). Never derived from who calls a service or feeds its queue.
 */
export class RuntimeProductMembership {
    /**
     * Stamp `products` onto every service of `graph` whose project declares any. `projects` is the
     * dependency graph, whose `products` are exactly each project's declared tags (ProductMembership);
     * a service whose project declares none gets no field.
     */
    apply(graph: RuntimeGraph, projects: EnhancedGraph): void {
        for (const [name, service] of Object.entries(graph.services)) {
            const declared = projects[name]?.products ?? [];
            if (declared.length > 0) service.products = [...declared].sort();
        }
    }
}
