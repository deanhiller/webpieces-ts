/**
 * Product membership and palette (#1179): an untagged library belongs to every product whose tagged
 * project reaches it; a project's declared tags are final and stop the walk (#1201); the runtime graph
 * walks runtime dependsOn, through queues to their consumers, under the same rule.
 */
import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph, RuntimeService } from '../runtime-graph-model';
import {
    PRODUCT_PALETTE_SIZE,
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

    it('walks each seed down dependsOn — the closure is everything that can change the product', () => {
        const members = membership.compute(
            new Map([
                ['lang-angular', ['lang']],
                ['lang-server', ['lang']],
                ['helper-server', ['helper']],
            ]),
            GRAPH,
        );
        expect(members.get('lang-apis')).toEqual(['lang']);
        expect(members.get('helper-lib')).toEqual(['helper']);
        expect(members.get('core')).toEqual(['helper', 'lang']);
        expect(members.get('lang-angular')).toEqual(['lang']);
        expect(members.has('unreached')).toBe(false);
        expect(members.has('shared-server')).toBe(false);
    });

    it('a project tagged with several products carries all of them down', () => {
        const members = membership.compute(new Map([['shared-server', ['bugfixer', 'helper']]]), GRAPH);
        expect(members.get('shared-server')).toEqual(['bugfixer', 'helper']);
        expect(members.get('core')).toEqual(['bugfixer', 'helper']);
    });

    it('a tagged library reached by another product keeps ONLY its own products (#1201)', () => {
        const members = membership.compute(
            new Map([
                ['lang-angular', ['example']],
                ['lang-apis', ['platform']],
            ]),
            GRAPH,
        );
        expect(members.get('lang-apis')).toEqual(['platform']);
        expect(members.get('lang-angular')).toEqual(['example']);
    });

    it('an untagged library reached by two products gets both', () => {
        const members = membership.compute(
            new Map([
                ['lang-server', ['lang']],
                ['shared-server', ['helper']],
            ]),
            GRAPH,
        );
        expect(members.get('core')).toEqual(['helper', 'lang']);
    });

    it('the walk stops at a tagged project — its dependencies are reached only by its own walk', () => {
        // lang-angular -> lang-apis (tagged platform) -> core: core is platform's, never example's.
        const members = membership.compute(
            new Map([
                ['lang-angular', ['example']],
                ['lang-apis', ['platform']],
            ]),
            GRAPH,
        );
        expect(members.get('core')).toEqual(['platform']);
    });

    it('a tagged project with several products keeps exactly those even when reached', () => {
        const graph: EnhancedGraph = {
            lib: { level: 0, dependsOn: [] },
            app: { level: 1, dependsOn: ['lib'] },
        };
        const members = membership.compute(
            new Map([
                ['app', ['example']],
                ['lib', ['platform', 'rules']],
            ]),
            graph,
        );
        expect(members.get('lib')).toEqual(['platform', 'rules']);
    });

    it('no tags anywhere means no membership at all', () => {
        expect(membership.compute(new Map(), GRAPH).size).toBe(0);
    });

    it('ignores a seed that is not in the graph', () => {
        expect(membership.compute(new Map([['ghost', ['lang']]]), GRAPH).size).toBe(0);
    });
});

function service(dependsOn: string[]): RuntimeService {
    return { level: 0, implements: [], uses: [], dependsOn };
}

describe('RuntimeProductMembership', () => {
    it('keeps the seeds plus every service they reach at runtime, through a queue to its consumers', () => {
        const runtime: RuntimeGraph = {
            services: {
                'lang-angular': service(['lang-server']),
                'lang-server': service(['helper-fsdb', 'queue:MailApi.send']),
                'helper-fsdb': service([]),
                'mail-worker': service([]),
                'bugfixer-server': service([]),
            },
            apis: {},
            runtimeEdges: [],
            unresolvedUses: [],
            queues: {
                'MailApi.send': {
                    api: 'MailApi',
                    method: 'send',
                    queueName: 'MailApi-send',
                    producedBy: ['lang-server'],
                    consumedBy: ['mail-worker'],
                },
            },
            triggers: [],
        };
        const projects: EnhancedGraph = {
            'lang-angular': { level: 3, dependsOn: [], products: ['lang'] },
            'lang-server': { level: 3, dependsOn: [], products: ['lang'] },
            'helper-fsdb': { level: 3, dependsOn: [], products: ['helper'] },
            'mail-worker': { level: 3, dependsOn: [] },
            'bugfixer-server': { level: 3, dependsOn: [], products: ['bugfixer'] },
        };

        new RuntimeProductMembership().apply(runtime, projects);

        expect(runtime.services['lang-angular'].products).toEqual(['lang']);
        // A cross-product callee keeps ONLY its own products (#1201); the coupling shows as the edge.
        expect(runtime.services['helper-fsdb'].products).toEqual(['helper']);
        expect(runtime.services['mail-worker'].products).toEqual(['lang']);
        expect(runtime.services['bugfixer-server'].products).toEqual(['bugfixer']);
    });

    it('stops at a service with products of its own; an untagged service reached by two products gets both', () => {
        const runtime: RuntimeGraph = {
            services: {
                'lang-server': service(['helper-server', 'shared-worker']),
                'helper-server': service(['helper-only-worker']),
                'helper-only-worker': service([]),
                'shared-worker': service([]),
                'bugfixer-server': service(['shared-worker']),
            },
            apis: {},
            runtimeEdges: [],
            unresolvedUses: [],
            queues: {},
            triggers: [],
        };
        const projects: EnhancedGraph = {
            'lang-server': { level: 3, dependsOn: [], products: ['lang'] },
            'helper-server': { level: 3, dependsOn: [], products: ['helper'] },
            'helper-only-worker': { level: 3, dependsOn: [] },
            'shared-worker': { level: 3, dependsOn: [] },
            'bugfixer-server': { level: 3, dependsOn: [], products: ['bugfixer'] },
        };

        new RuntimeProductMembership().apply(runtime, projects);

        expect(runtime.services['helper-server'].products).toEqual(['helper']);
        expect(runtime.services['helper-only-worker'].products).toEqual(['helper']);
        expect(runtime.services['shared-worker'].products).toEqual(['bugfixer', 'lang']);
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

    it(`gives the first ${PRODUCT_PALETTE_SIZE} distinct colors and the neutral fill past them`, () => {
        const names = Array.from({ length: PRODUCT_PALETTE_SIZE + 2 }, (_: unknown, i: number): string => `p${i + 10}`);
        const palette = new ProductPalette(names);
        const colored = palette.colors.filter((color: ProductColor): boolean => color.inPalette);
        expect(colored).toHaveLength(PRODUCT_PALETTE_SIZE);
        expect(new Set(colored.map((color: ProductColor): string => color.color)).size).toBe(PRODUCT_PALETTE_SIZE);
        expect(palette.colorOf(names[PRODUCT_PALETTE_SIZE]).color).toBe(PRODUCT_SHARED_FILL);
        expect(palette.overflows()).toBe(true);
        expect(new ProductPalette(['lang']).overflows()).toBe(false);
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
