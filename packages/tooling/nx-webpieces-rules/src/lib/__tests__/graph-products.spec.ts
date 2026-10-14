/**
 * Product membership and palette (#1179): membership is TAGS ONLY on both graphs (#1216) — a project's
 * products are exactly its declared `product:` tags, a runtime service's exactly its project's, and an
 * untagged project or service is in no product however it is reached.
 */
import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph, RuntimeService } from '../runtime-graph-model';
import {
    PRODUCT_PALETTE_SLOTS,
    PRODUCT_SHARED_FILL,
    ProductColor,
    ProductMembership,
    ProductPalette,
    RuntimeProductMembership,
} from '../graph-products';

/** lang-angular and lang-server meet only through lang-apis — the HTTP call is no nx edge. */
const GRAPH: EnhancedGraph = {
    core: { level: 0, dependsOn: [] },
    'lang-apis': { level: 1, dependsOn: ['core'] },
    'helper-lib': { level: 1, dependsOn: ['core'] },
    'lang-angular': { level: 2, dependsOn: ['lang-apis'] },
    'lang-server': { level: 2, dependsOn: ['lang-apis'] },
    'helper-server': { level: 2, dependsOn: ['helper-lib'] },
    'shared-server': { level: 2, dependsOn: ['core'] },
    unreached: { level: 0, dependsOn: [] },
};

describe('ProductMembership', () => {
    const membership = new ProductMembership();

    it("a project's products are exactly its declared tags, sorted", () => {
        const members = membership.compute(
            new Map([
                ['lang-angular', ['lang']],
                ['shared-server', ['helper', 'bugfixer']],
            ]),
            GRAPH,
        );
        expect(members.get('lang-angular')).toEqual(['lang']);
        expect(members.get('shared-server')).toEqual(['bugfixer', 'helper']);
        expect([...members.keys()].sort()).toEqual(['lang-angular', 'shared-server']);
    });

    it('a tagged project that depends on an untagged one leaves the untagged one with no products (#1216)', () => {
        // lang-angular -> lang-apis -> core, and lang-server -> lang-apis: nothing is inherited down an edge.
        const members = membership.compute(
            new Map([
                ['lang-angular', ['lang']],
                ['lang-server', ['lang']],
                ['helper-server', ['helper']],
            ]),
            GRAPH,
        );
        expect(members.has('lang-apis')).toBe(false);
        expect(members.has('helper-lib')).toBe(false);
        expect(members.has('core')).toBe(false);
    });

    it('a tagged library depended on by another product keeps only its own products', () => {
        const members = membership.compute(
            new Map([
                ['lang-angular', ['example']],
                ['lang-apis', ['platform', 'rules']],
            ]),
            GRAPH,
        );
        expect(members.get('lang-apis')).toEqual(['platform', 'rules']);
        expect(members.get('lang-angular')).toEqual(['example']);
    });

    it('no tags anywhere means no membership at all', () => {
        expect(membership.compute(new Map(), GRAPH).size).toBe(0);
    });

    it('ignores a seed that is not in the graph, and an empty tag list', () => {
        expect(
            membership.compute(
                new Map([
                    ['ghost', ['lang']],
                    ['core', []],
                ]),
                GRAPH,
            ).size,
        ).toBe(0);
    });
});

function service(dependsOn: string[]): RuntimeService {
    return { level: 0, implements: [], uses: [], dependsOn };
}

describe('RuntimeProductMembership', () => {
    it("stamps each service with exactly its project's declared products", () => {
        const runtime: RuntimeGraph = {
            services: {
                'lang-angular': service(['lang-server']),
                'lang-server': service(['helper-fsdb']),
                'helper-fsdb': service([]),
            },
            apis: {},
            runtimeEdges: [],
            unresolvedUses: [],
            queues: {},
            triggers: [],
        };
        const projects: EnhancedGraph = {
            'lang-angular': { level: 3, dependsOn: [], products: ['lang'] },
            'lang-server': { level: 3, dependsOn: [], products: ['lang'] },
            'helper-fsdb': { level: 3, dependsOn: [], products: ['helper', 'bugfixer'] },
        };

        new RuntimeProductMembership().apply(runtime, projects);

        expect(runtime.services['lang-angular'].products).toEqual(['lang']);
        // A cross-product callee keeps ONLY its own products; the coupling shows as the runtime edge.
        expect(runtime.services['helper-fsdb'].products).toEqual(['bugfixer', 'helper']);
    });

    it('a tagged service that calls an untagged one, directly or through a queue, leaves it with no products (#1216)', () => {
        const runtime: RuntimeGraph = {
            services: {
                'example-server': service(['untagged-server', 'queue:MailApi.send']),
                'untagged-server': service([]),
                'mail-worker': service([]),
            },
            apis: {},
            runtimeEdges: [],
            unresolvedUses: [],
            queues: {
                'MailApi.send': {
                    api: 'MailApi',
                    method: 'send',
                    queueName: 'MailApi-send',
                    producedBy: ['example-server'],
                    consumedBy: ['mail-worker'],
                },
            },
            triggers: [],
        };
        const projects: EnhancedGraph = {
            'example-server': { level: 3, dependsOn: [], products: ['example'] },
            'untagged-server': { level: 3, dependsOn: [] },
            'mail-worker': { level: 3, dependsOn: [] },
        };

        new RuntimeProductMembership().apply(runtime, projects);

        expect(runtime.services['example-server'].products).toEqual(['example']);
        expect('products' in runtime.services['untagged-server']).toBe(false);
        expect('products' in runtime.services['mail-worker']).toBe(false);
    });

    it('writes no field when nothing declares a product', () => {
        const runtime: RuntimeGraph = {
            services: { svc: service([]) },
            apis: {},
            runtimeEdges: [],
            unresolvedUses: [],
            queues: {},
            triggers: [],
        };
        new RuntimeProductMembership().apply(runtime, { svc: { level: 0, dependsOn: [] } });
        expect('products' in runtime.services['svc']).toBe(false);
    });
});

describe('ProductPalette', () => {
    it('assigns colors in sorted product-name order, so the same products always read the same way', () => {
        const a = new ProductPalette(['lang', 'bugfixer']);
        const b = new ProductPalette(['bugfixer', 'lang', 'lang']);
        expect(a.names()).toEqual(['bugfixer', 'lang']);
        expect(a.colorOf('lang').color).toBe(b.colorOf('lang').color);
    });

    it('pins this repo\'s six products to their concrete colors, all distinct (#1244)', () => {
        const palette = new ProductPalette(['api-model', 'core', 'example', 'openapi', 'platform', 'rules']);
        const pinned = palette.colors.map((color: ProductColor): string => `${color.product} ${color.color} ${color.fontColor}`);
        expect(pinned).toEqual([
            'api-model #8e5ea2 #ffffff',
            'core #edc948 #1a1c22',
            'example #3f6fb5 #ffffff',
            // openapi hashes to core's slot (5); core sorts first and keeps it, openapi takes 6, which
            // api-model holds, so it wraps on to 7.
            'openapi #ff9da7 #1a1c22',
            'platform #c0392b #ffffff',
            'rules #3d8b3d #ffffff',
        ]);
        expect(new Set(palette.colors.map((color: ProductColor): string => color.color)).size).toBe(6);
    });

    it('restores the eight saturated pre-#1226 colors, each with its text color', () => {
        expect(PRODUCT_PALETTE_SLOTS.map((slot): string => `${slot.color} ${slot.fontColor}`)).toEqual([
            '#3f6fb5 #ffffff',
            '#f28e2b #1a1c22',
            '#c0392b #ffffff',
            '#5cb8b2 #1a1c22',
            '#3d8b3d #ffffff',
            '#edc948 #1a1c22',
            '#8e5ea2 #ffffff',
            '#ff9da7 #1a1c22',
        ]);
    });

    it('hashes the name to a preferred slot: SHA-256, first byte, mod 8', () => {
        const palette = new ProductPalette([]);
        expect(palette.preferredSlot('core')).toBe(5);
        expect(palette.preferredSlot('openapi')).toBe(5);
        expect(palette.preferredSlot('example')).toBe(0);
        // A lone product always gets its preferred slot.
        expect(new ProductPalette(['openapi']).colorOf('openapi').color).toBe(PRODUCT_PALETTE_SLOTS[5].color);
    });

    it('never duplicates a color for eight or fewer products', () => {
        for (let size = 1; size <= 8; size++) {
            const names = Array.from({ length: size }, (_: unknown, i: number): string => `product-${i}`);
            const colors = new ProductPalette(names).colors.map((color: ProductColor): string => color.color);
            expect(new Set(colors).size).toBe(size);
        }
    });

    it('adding an unrelated product whose slot is free changes no existing color', () => {
        const products = ['api-model', 'core', 'example', 'openapi', 'platform', 'rules'];
        const before = new ProductPalette(products);
        // bugfixer hashes to slot 3, which none of the six holds.
        const palette = new ProductPalette([]);
        expect(palette.preferredSlot('bugfixer')).toBe(3);
        const after = new ProductPalette([...products, 'bugfixer']);
        for (const product of products) expect(after.colorOf(product)).toEqual(before.colorOf(product));
        expect(after.colorOf('bugfixer').color).toBe(PRODUCT_PALETTE_SLOTS[3].color);
    });

    it('ignores input order and duplicates', () => {
        const products = ['api-model', 'core', 'example', 'openapi', 'platform', 'rules'];
        const full = new ProductPalette(products);
        expect(new ProductPalette([...products].reverse()).colors).toEqual(full.colors);
        expect(new ProductPalette([...products, ...products]).colors).toEqual(full.colors);
    });

    it('past eight products, a product shares its preferred slot\'s color — never the neutral fill', () => {
        const names = Array.from({ length: 20 }, (_: unknown, i: number): string => `product-${i}`);
        const palette = new ProductPalette(names);
        const slotColors = PRODUCT_PALETTE_SLOTS.map((slot): string => slot.color);
        expect(new Set(palette.colors.map((color: ProductColor): string => color.color)).size).toBe(8);
        for (const color of palette.colors.slice(8)) {
            expect(color.color).toBe(PRODUCT_PALETTE_SLOTS[palette.preferredSlot(color.product)].color);
        }
        expect(palette.colors.every((color: ProductColor): boolean => slotColors.includes(color.color))).toBe(true);
        expect(palette.colors.every((color: ProductColor): boolean => color.color !== PRODUCT_SHARED_FILL)).toBe(true);
    });

    it('a box is shared by every product only when two or more are declared', () => {
        const palette = new ProductPalette(['bugfixer', 'lang']);
        expect(palette.sharedByAll(['bugfixer', 'lang'])).toBe(true);
        expect(palette.sharedByAll(['lang'])).toBe(false);
        expect(new ProductPalette(['lang']).sharedByAll(['lang'])).toBe(false);
    });

    it('collects every product of a graph', () => {
        const palette = ProductPalette.fromGraph({
            a: { level: 0, dependsOn: [], products: ['lang'] },
            b: { level: 0, dependsOn: [], products: ['helper', 'lang'] },
            c: { level: 0, dependsOn: [] },
        });
        expect(palette.names()).toEqual(['helper', 'lang']);
    });
});
