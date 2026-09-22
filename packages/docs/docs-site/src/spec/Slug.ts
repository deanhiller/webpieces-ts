/**
 * URL slugs. One pre-rendered HTML file per URL means the slug IS the filename, so it has to be
 * stable, lower-case and free of anything a filesystem or a static host treats specially.
 *
 * Uniqueness is enforced rather than hoped for: two operations that kebab to the same string would
 * otherwise silently overwrite each other's page, and the missing one looks exactly like an
 * operation that was never documented. Uniqueness is per INSTANCE, so operations and schemas —
 * which live in different directories — do not collide with each other for no reason.
 */
export class Slug {
    private readonly taken = new Set<string>();

    /** `fetchOrders` -> `fetch-orders`, `order.state-changed` -> `order-state-changed`. */
    kebab(name: string): string {
        const spaced = name
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
        const cleaned = spaced
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return cleaned === '' ? 'page' : cleaned;
    }

    /** The kebab of `name`, suffixed `-2`, `-3`, … if this instance has already handed it out. */
    unique(name: string): string {
        const base = this.kebab(name);
        if (!this.taken.has(base)) {
            this.taken.add(base);
            return base;
        }
        let counter = 2;
        while (this.taken.has(`${base}-${counter}`)) {
            counter++;
        }
        const chosen = `${base}-${counter}`;
        this.taken.add(chosen);
        return chosen;
    }
}
