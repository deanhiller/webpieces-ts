/**
 * The product dependency matrix (#1204): which products may depend on which.
 *
 * Product membership (graph-products.ts) says which product OWNS each box; this says which products
 * may DEPEND on which, so a platform library quietly importing example code is a generation failure
 * instead of one more edge on the graph. It is the second half of the `product-tags` rule — one switch
 * turns the tags requirement and this matrix on and off together.
 *
 *   "productDependencies": [
 *     { "name": "example", "allowedToDependOn": ["platform", "openapi"] },
 *     { "name": "openapi", "allowedToDependOn": ["platform"] }
 *   ]
 *
 * Semantics:
 *  - A product may always depend on itself (implied, never listed). A product with no entry may depend
 *    only on itself; `[]` as the whole field means no product depends on another.
 *  - An edge A -> B of the DEPENDENCY graph is legal when, for EVERY product p of A, B carries p or a
 *    product p's entry allows. A multi-product B satisfies p when ANY of its products is allowed.
 *  - The check reads `products` in dependencies.json, which is exactly each project's declared tags
 *    (#1216). An edge with an UNTAGGED end is skipped: an untagged project is in no product and
 *    constrains nothing. So an untagged library is a hole in the check (example app -> untagged lib
 *    -> platform lib is never judged); a consumer closes it by listing its library roles in
 *    `product-tags.roles`, which makes every such project carry a tag.
 *  - An entry `name`, or an `allowedToDependOn` value, that no `product:` tag uses fails naming it, and
 *    so does a duplicate `name`: a typo must never silently allow or forbid nothing.
 *
 * The runtime graph (HTTP / queue calls between products' services) is deliberately NOT checked:
 * RuntimeProductMembership shows a cross-product call as coupling for a reviewer to see.
 */

import type { EnhancedGraph } from './graph-sorter';
import { ProductDependencyEntry } from '../configs/tag-truth-configs';

const RULE = 'product-tags';
const FIELD = `${RULE}.productDependencies`;

export class ProductDependencyMatrix {
    /** product → the products it may depend on, itself included. */
    private readonly allowed = new Map<string, Set<string>>();

    constructor(public readonly entries: readonly ProductDependencyEntry[]) {
        for (const entry of entries) {
            const set = this.allowed.get(entry.name) ?? new Set<string>([entry.name]);
            for (const other of entry.allowedToDependOn) set.add(other);
            this.allowed.set(entry.name, set);
        }
    }

    /** The products a project of `product` may depend on: itself plus its entry's list. */
    allowedFor(product: string): Set<string> {
        return this.allowed.get(product) ?? new Set<string>([product]);
    }

    /**
     * Every problem: the matrix's own (unknown names, duplicates), then every illegal edge.
     *
     * @param declared every product some project's `product:` tag names
     */
    problems(graph: EnhancedGraph, declared: ReadonlySet<string>): string[] {
        return [...this.configProblems(declared), ...this.edgeProblems(graph)];
    }

    /** A `name` or `allowedToDependOn` value no `product:` tag uses, and a duplicate `name`. */
    configProblems(declared: ReadonlySet<string>): string[] {
        const problems: string[] = [];
        const known = [...declared].sort();
        const knownText = known.length === 0 ? 'none — no project carries a product: tag' : known.join(', ');
        const seen = new Set<string>();
        for (const entry of this.entries) {
            if (seen.has(entry.name)) {
                problems.push(
                    `${FIELD}: product '${entry.name}' has two entries — merge them into one ` +
                        `{ "name": "${entry.name}", "allowedToDependOn": [...] } so its allowance is stated once.`,
                );
            }
            seen.add(entry.name);
            if (!declared.has(entry.name)) {
                problems.push(
                    `${FIELD}: entry "name": "${entry.name}" matches no product: tag (products in use: ${knownText}) — ` +
                        'fix the typo, or delete the entry.',
                );
            }
            for (const other of entry.allowedToDependOn) {
                if (declared.has(other)) continue;
                problems.push(
                    `${FIELD}: "${entry.name}" allowedToDependOn "${other}", which matches no product: tag ` +
                        `(products in use: ${knownText}) — fix the typo, or remove it from the list.`,
                );
            }
        }
        return problems;
    }

    /** Every dependency edge, once per product of its source that none of its target's products is allowed for. */
    edgeProblems(graph: EnhancedGraph): string[] {
        const problems: string[] = [];
        for (const name of Object.keys(graph).sort()) {
            const from = graph[name].products ?? [];
            if (from.length === 0) continue;
            for (const dep of [...(graph[name].dependsOn ?? [])].sort()) {
                const to = graph[dep]?.products ?? [];
                // #1216: an untagged target is in no product and constrains nothing — see the header.
                if (to.length === 0) continue;
                for (const product of from) {
                    if (this.satisfies(product, to)) continue;
                    problems.push(this.violation(name, from, dep, to, product));
                }
            }
        }
        return problems;
    }

    /** True when `to` carries `product` or some product `product` may depend on. */
    private satisfies(product: string, to: readonly string[]): boolean {
        const allowed = this.allowedFor(product);
        return to.some((other: string): boolean => allowed.has(other));
    }

    private violation(name: string, from: readonly string[], dep: string, to: readonly string[], product: string): string {
        const allowed = [...this.allowedFor(product)].sort();
        return (
            `${RULE}: '${name}' [${from.join(', ')}] -> '${dep}' [${to.join(', ')}] crosses a product boundary — product ` +
            `'${product}' may depend only on [${allowed.join(', ')}]. Either move the code so the dependency stays ` +
            `inside an allowed product, or ${this.cure(to, product)} in webpieces.config.json (a reviewed one-line change).`
        );
    }

    /** The config edit that would allow the edge: one of the target's products, any of which is enough. */
    private cure(to: readonly string[], product: string): string {
        const pick = to[0];
        const anyOf = to.length > 1 ? ` (any one of [${to.join(', ')}] is enough)` : '';
        const entry = this.entries.find((each: ProductDependencyEntry): boolean => each.name === product);
        const edit =
            entry === undefined
                ? `add { "name": "${product}", "allowedToDependOn": ["${pick}"] } to ${FIELD}`
                : `add "${pick}" to the "${product}" entry's allowedToDependOn in ${FIELD}`;
        return edit + anyOf;
    }
}
