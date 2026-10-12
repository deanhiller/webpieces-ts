/**
 * Products on the architecture graphs (#1179).
 *
 * A monorepo can hold several PRODUCTS, each with its own clients and servers. A product is declared
 * on its entry points with the nx tag `product:<name>` (product-resolver.ts); everything else a
 * product consists of is DERIVED here, never declared:
 *
 *  - ProductMembership — the dependency graph. A project's OWN `product:` tags are FINAL (#1201): a
 *    project that declares any keeps exactly its declared set. An UNTAGGED project belongs to every
 *    product whose tagged project reaches it by a downward walk over `dependsOn` — and that walk stops
 *    at a tagged project, whose own dependencies are reached by its own seed walk. That closure is
 *    everything that can change the product's behaviour, so it is what a reviewer of that product
 *    reviews. It must start from EVERY entry point, clients and servers both: a client reaches its
 *    server only over HTTP, never through an nx edge, so a server is in its product only because it is
 *    tagged. Why final: a project is one product's, never two by accident — the example apps depend on
 *    the platform libraries, and a platform library tagged `product:platform` must not be painted
 *    `example` because an example reaches it. A published library whose entry points live in OTHER
 *    repos carries its own tag for exactly that reason: no in-repo walk can ever reach it correctly.
 *  - RuntimeProductMembership — the runtime graph, under the same rule. A service that already carries
 *    products (declared, or derived on the dependency graph above) keeps exactly them; a service with
 *    none belongs to every product whose service reaches it over RUNTIME `dependsOn`, including through
 *    a queue to its consumers, and that walk stops at a service with products of its own. A call from
 *    one product into another product's service still shows — as the runtime EDGE between them.
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

/**
 * The architecture graph's product membership: declared seeds walked DOWN over `dependsOn`, where a
 * project's own declared products are final.
 */
export class ProductMembership {
    /**
     * @param seeds project → the products it DECLARES (its `product:` tags)
     * @returns project → its sorted products: exactly its declared set when it declares any; otherwise
     *          every product whose tagged project reaches it without passing through another tagged
     *          project. A project in no product is absent, so with no tag anywhere the map is empty.
     */
    compute(seeds: ReadonlyMap<string, readonly string[]>, graph: EnhancedGraph): Map<string, string[]> {
        const declared = new Map<string, readonly string[]>();
        seeds.forEach((products: readonly string[], seed: string): void => {
            if (products.length > 0 && graph[seed] !== undefined) declared.set(seed, products);
        });
        const members = new Map<string, Set<string>>();
        declared.forEach((products: readonly string[], seed: string): void => {
            members.set(seed, new Set(products));
        });
        declared.forEach((products: readonly string[], seed: string): void => {
            for (const project of this.closure(seed, graph, declared)) {
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

    /**
     * Every UNTAGGED project `seed` reaches through `dependsOn`. A tagged project is neither collected
     * nor walked through: its products are final, and its own seed walk covers its dependencies.
     */
    private closure(seed: string, graph: EnhancedGraph, declared: ReadonlyMap<string, readonly string[]>): Set<string> {
        const seen = new Set<string>([seed]);
        const reached = new Set<string>();
        const stack = [seed];
        while (stack.length > 0) {
            const project = stack.pop() as string;
            for (const dep of graph[project]?.dependsOn ?? []) {
                if (seen.has(dep)) continue;
                seen.add(dep);
                if (declared.has(dep)) continue;
                reached.add(dep);
                stack.push(dep);
            }
        }
        return reached;
    }
}

/**
 * The runtime graph's product membership: services that carry products walked over RUNTIME
 * `dependsOn`, where a service's own products are final.
 */
export class RuntimeProductMembership {
    /**
     * Stamp `products` onto every service of `graph` that some product reaches. Seeds are the
     * services whose dependencies.json entry carries `products`, and each keeps exactly those; a
     * service with none gets every product whose seed reaches it without passing through another
     * seed. A `queue:<Api.method>` dependency is followed to that queue's consumers. A service in no
     * product gets no field.
     */
    apply(graph: RuntimeGraph, projects: EnhancedGraph): void {
        const seeds = new Map<string, readonly string[]>();
        for (const name of Object.keys(graph.services)) {
            const own = projects[name]?.products ?? [];
            if (own.length > 0) seeds.set(name, own);
        }
        const members = new Map<string, Set<string>>();
        seeds.forEach((own: readonly string[], name: string): void => {
            members.set(name, new Set(own));
        });
        seeds.forEach((own: readonly string[], name: string): void => {
            for (const reached of this.closure(name, graph, seeds)) {
                const set = members.get(reached) ?? new Set<string>();
                for (const product of own) set.add(product);
                members.set(reached, set);
            }
        });
        members.forEach((set: Set<string>, name: string): void => {
            const service = graph.services[name];
            if (service !== undefined) service.products = [...set].sort();
        });
    }

    /** Every service WITHOUT products of its own that `seed` reaches; a seed is neither collected nor walked through. */
    private closure(seed: string, graph: RuntimeGraph, seeds: ReadonlyMap<string, readonly string[]>): Set<string> {
        const seen = new Set<string>([seed]);
        const reached = new Set<string>();
        const stack = [seed];
        while (stack.length > 0) {
            const name = stack.pop() as string;
            for (const next of this.callees(name, graph)) {
                if (seen.has(next) || graph.services[next] === undefined) continue;
                seen.add(next);
                if (seeds.has(next)) continue;
                reached.add(next);
                stack.push(next);
            }
        }
        return reached;
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
