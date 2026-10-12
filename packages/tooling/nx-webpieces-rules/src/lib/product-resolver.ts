/**
 * Product Resolver (#1179)
 *
 * Reads the products a project DECLARES with the nx tag `product:<name>` on its project.json:
 *
 *   "tags": ["framework:angular", "role:client", "product:lang"]
 *
 * A monorepo holding several products tags each product's ENTRY POINTS (servers, clients, apps —
 * the `product-tags` rule makes that required) and the architecture graphs derive the rest: an
 * UNTAGGED library belongs to every product whose tagged project reaches it (graph-products.ts).
 * A library MAY carry its own tag — a published library whose entry points live in other repos, which
 * no in-repo walk can reach correctly — and a project's declared tags are FINAL (#1201): a tagged
 * project keeps exactly its declared set, and no other product's walk paints it or passes through it.
 *
 * Several tags are allowed (`product:bugfixer` + `product:helper`). Each name must be lowercase
 * kebab (`lang`, `job-finder`); a malformed tag (`product:`, `product:Lang`) is a problem that fails
 * generation with the project named — the same way two `role:` tags do (role-resolver.ts).
 *
 * Why a tag and not a config key: it moves with the project, nx understands it for free
 * (`nx show projects --projects tag:product:lang`), and a tag an older plugin does not know is ignored,
 * so a consumer can tag BEFORE the release that reads the tags ships.
 */

import { ProjectInfo } from './project-info';

export const PRODUCT_TAG_PREFIX = 'product:';

/** Lowercase kebab: letters and digits, single dashes between words, no leading/trailing dash. */
const PRODUCT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class ProductResolution {
    constructor(
        /** The declared product names, sorted and de-duplicated; empty when the project declares none. */
        public readonly products: string[],
        /** One line per malformed tag, naming the project; empty when every tag is well formed. */
        public readonly problems: string[],
    ) {}
}

export class ProductResolver {
    /** Every `product:` tag the project carries, validated. */
    resolve(info: ProjectInfo): ProductResolution {
        const products = new Set<string>();
        const problems: string[] = [];
        for (const tag of info.tags) {
            if (!tag.startsWith(PRODUCT_TAG_PREFIX)) continue;
            const name = tag.slice(PRODUCT_TAG_PREFIX.length);
            if (this.isValidName(name)) {
                products.add(name);
                continue;
            }
            problems.push(
                `${info.name}: product tag '${tag}' is malformed — the name after 'product:' must be lowercase ` +
                    `kebab (e.g. 'product:lang', 'product:job-finder')`,
            );
        }
        return new ProductResolution([...products].sort(), problems);
    }

    isValidName(name: string): boolean {
        return PRODUCT_NAME.test(name);
    }
}
