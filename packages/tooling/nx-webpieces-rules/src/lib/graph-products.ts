/**
 * Products on the architecture graphs (#1179).
 *
 * A monorepo can hold several PRODUCTS, each with its own clients and servers. A product is declared
 * on its entry points with the nx tag `product:<name>` (product-resolver.ts); everything else a
 * product consists of is DERIVED here, never declared:
 *
 *  - ProductMembership — the dependency graph. A project belongs to every product whose tagged project
 *    reaches it by a downward walk over `dependsOn`. That closure is everything that can change the
 *    product's behaviour, so it is what a reviewer of that product reviews. It must start from EVERY
 *    entry point, clients and servers both: a client reaches its server only over HTTP, never through
 *    an nx edge, so a server is in its product only because it is tagged.
 *  - RuntimeProductMembership — the runtime graph. The services in a product are its seeds plus every
 *    service reachable over RUNTIME `dependsOn`, including through a queue to its consumers — so a
 *    call from one product into another product's service shows, which is exactly the cross-product
 *    coupling a reviewer needs to see.
 *  - ProductPalette — the Product color mode's colors: a fixed palette of eight assigned in sorted
 *    product-name order, a neutral fill for a box shared by EVERY product, and a dashed white box for
 *    one in no product.
 *
 * Membership is stable per checkout (it depends on tags and edges, never on a diff), so it is written
 * into the committed dependencies.json / runtime-dependencies.json rather than into a sidecar.
 */

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
        /** False for a product past the palette's eight, which is painted with the neutral fill. */
        public readonly inPalette: boolean,
    ) {}
}

/** The eight product colors, in assignment order. Distinct from every runtime and role color. */
const PRODUCT_COLORS: readonly (readonly [string, string])[] = [
    ['#3f6fb5', LIGHT_TEXT],
    ['#f28e2b', DARK_TEXT],
    ['#c0392b', LIGHT_TEXT],
    ['#5cb8b2', DARK_TEXT],
    ['#3d8b3d', LIGHT_TEXT],
    ['#edc948', DARK_TEXT],
    ['#8e5ea2', LIGHT_TEXT],
    ['#ff9da7', DARK_TEXT],
];

/** How many products get a color of their own; any further product uses the neutral fill. */
export const PRODUCT_PALETTE_SIZE = PRODUCT_COLORS.length;

/** A box shared by EVERY product, and every product past the palette's eight. */
export const PRODUCT_SHARED_FILL = '#c9ced8';
/** A box in no product: white, with a dashed border. */
export const PRODUCT_NONE_FILL = '#ffffff';
export const PRODUCT_NONE_BORDER = '#8a90a0';

export class ProductPalette {
    /** Every declared product, sorted, each with its color. */
    readonly colors: ProductColor[];

    constructor(products: readonly string[]) {
        const sorted = [...new Set(products)].sort();
        this.colors = sorted.map((product: string, index: number): ProductColor => {
            const entry = PRODUCT_COLORS[index];
            if (entry === undefined) return new ProductColor(product, PRODUCT_SHARED_FILL, DARK_TEXT, false);
            return new ProductColor(product, entry[0], entry[1], true);
        });
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
        return (
            this.colors.find((color: ProductColor): boolean => color.product === product) ??
            new ProductColor(product, PRODUCT_SHARED_FILL, DARK_TEXT, false)
        );
    }

    /** True for a box carrying every product of a workspace that declares two or more. */
    sharedByAll(products: readonly string[]): boolean {
        return this.colors.length > 1 && this.colors.every((color: ProductColor): boolean => products.includes(color.product));
    }

    /** True when some product is past the palette's eight, so the legend must say it is neutral. */
    overflows(): boolean {
        return this.colors.some((color: ProductColor): boolean => !color.inPalette);
    }
}

/** The architecture graph's product membership: declared seeds walked DOWN over `dependsOn`. */
export class ProductMembership {
    /**
     * @param seeds project → the products it DECLARES (its `product:` tags)
     * @returns project → the sorted products whose tagged projects reach it; a project in no product
     *          is absent, so with no tag anywhere the map is empty
     */
    compute(seeds: ReadonlyMap<string, readonly string[]>, graph: EnhancedGraph): Map<string, string[]> {
        const members = new Map<string, Set<string>>();
        seeds.forEach((products: readonly string[], seed: string): void => {
            if (products.length === 0 || graph[seed] === undefined) return;
            for (const project of this.closure(seed, graph)) {
                const set = members.get(project) ?? new Set<string>();
                for (const product of products) set.add(product);
                members.set(project, set);
            }
        });
        const result = new Map<string, string[]>();
        members.forEach((set: Set<string>, project: string): void => {
            result.set(project, [...set].sort());
        });
        return result;
    }

    /** `seed` plus every project it reaches through `dependsOn`. */
    private closure(seed: string, graph: EnhancedGraph): Set<string> {
        const seen = new Set<string>([seed]);
        const stack = [seed];
        while (stack.length > 0) {
            const project = stack.pop() as string;
            for (const dep of graph[project]?.dependsOn ?? []) {
                if (seen.has(dep)) continue;
                seen.add(dep);
                stack.push(dep);
            }
        }
        return seen;
    }
}

/** The runtime graph's product membership: tagged services walked over RUNTIME `dependsOn`. */
export class RuntimeProductMembership {
    /**
     * Stamp `products` onto every service of `graph` that some product reaches. Seeds are the
     * services whose dependencies.json entry carries `products`; a `queue:<Api.method>` dependency is
     * followed to that queue's consumers. A service in no product gets no field.
     */
    apply(graph: RuntimeGraph, projects: EnhancedGraph): void {
        const members = new Map<string, Set<string>>();
        for (const name of Object.keys(graph.services)) {
            const seeded = projects[name]?.products ?? [];
            if (seeded.length === 0) continue;
            for (const reached of this.closure(name, graph)) {
                const set = members.get(reached) ?? new Set<string>();
                for (const product of seeded) set.add(product);
                members.set(reached, set);
            }
        }
        members.forEach((set: Set<string>, name: string): void => {
            const service = graph.services[name];
            if (service !== undefined) service.products = [...set].sort();
        });
    }

    private closure(seed: string, graph: RuntimeGraph): Set<string> {
        const seen = new Set<string>([seed]);
        const stack = [seed];
        while (stack.length > 0) {
            const name = stack.pop() as string;
            for (const next of this.callees(name, graph)) {
                if (seen.has(next) || graph.services[next] === undefined) continue;
                seen.add(next);
                stack.push(next);
            }
        }
        return seen;
    }

    /** The services one service calls: direct ones, and the consumers behind every queue it feeds. */
    private callees(name: string, graph: RuntimeGraph): string[] {
        const callees: string[] = [];
        for (const dep of graph.services[name]?.dependsOn ?? []) {
            if (!dep.startsWith('queue:')) {
                callees.push(dep);
                continue;
            }
            callees.push(...(graph.queues[dep.slice('queue:'.length)]?.consumedBy ?? []));
        }
        return callees;
    }
}
