/**
 * Products in a real browser (#1179): the architecture page's Product filter group and Product color
 * mode, and the runtime page's product chip row. Opt-in like the other Viz suites (WP_GRAPH_VIZ_JS).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from '@playwright/test';
import { FilterFixture } from './graph-filter-fixture';
import { BRANCH_LABEL, BrowserFixture, impactScan } from './graph-browser-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';
import { generateRuntimeRenderModel } from '../runtime-visualizer';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph } from '../runtime-graph-model';
import { ImpactKind, ImpactSidecarData } from '../graph-impact';
import { PRODUCT_NONE_FILL, PRODUCT_SHARED_FILL, ProductPalette } from '../graph-products';

/** Two products meeting in `model`; `orphan` is in neither. */
const GRAPH: EnhancedGraph = {
    'lang-web': { level: 3, dependsOn: ['lang-apis'], framework: ['browser', 'angular'], role: 'client', products: ['lang'] },
    'lang-svr': { level: 3, dependsOn: ['lang-apis'], framework: ['node'], role: 'server', products: ['lang'] },
    'help-svr': { level: 3, dependsOn: ['help-lib'], framework: ['node'], role: 'server', products: ['helper'] },
    'lang-apis': { level: 1, dependsOn: ['model'], framework: ['browser', 'node'], role: 'api-lib', products: ['lang'] },
    'help-lib': { level: 2, dependsOn: ['model'], framework: ['node'], role: 'lib', products: ['helper'] },
    model: { level: 0, dependsOn: [], framework: ['browser', 'node'], role: 'lib', products: ['helper', 'lang'] },
    orphan: { level: 0, dependsOn: [], framework: ['node'], role: 'lib' },
};

const fixture = new BrowserFixture();
describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('products in a real browser (#1179)', () => {
    beforeAll(() => fixture.start());
    afterAll(async () => fixture.browser?.close());

    it('Product chips intersect with Changes, Runtime and Role; two chips select the union; pills and clear work', async () => {
        const page = await fixture.openWithImpact(
            '1179-product-filter',
            fixture.architecture(GRAPH),
            new ImpactSidecarData(
                [
                    impactScan(
                        ImpactKind.BRANCH,
                        BRANCH_LABEL,
                        ['model'],
                        ['lang-apis', 'help-lib', 'lang-web', 'lang-svr', 'help-svr'],
                        [],
                        1,
                        [],
                    ),
                ],
                ImpactKind.BRANCH,
            ),
        );
        const apply = page.locator('#wp-filter-apply');
        await page.locator('#wp-filter-open').click();
        expect(await page.locator('#wp-product-group .wp-chip').allTextContents()).toEqual(['helper', 'lang']);
        // The labels have ONE source: the shell's markup, which the pills read back.
        expect(await page.locator('[data-wp-scope-label="build"]').textContent()).toBe('Changed + dependents + dependencies');
        await page.locator('.wp-chip[data-wp-chip-group="product"][data-wp-chip="lang"]').click();
        expect(await apply.textContent()).toBe('Show 4 projects');
        // Product ∩ Changes: what this branch builds that can affect lang.
        await page.locator('input[name="wp-scope"][value="changed"]').check();
        expect(await apply.textContent()).toBe('Show 1 project');
        await apply.click();
        expect(await fixture.names(page)).toEqual(['model']);
        expect(await page.locator('#wp-filter-badge').textContent()).toBe('2');
        expect(await page.locator('#wp-filter-pills').textContent()).toContain('product: lang');
        expect(await page.locator('#wp-filter-pills').textContent()).toContain('Changed');
        // The scope pill's ✕ leaves the product filter in place.
        await page.locator('#wp-filter-pills [data-wp-pill="scope:changed"] button').click();
        expect(await fixture.names(page)).toEqual(['lang-apis', 'lang-svr', 'lang-web', 'model']);
        // Intersects with Role and Runtime too.
        await page.locator('#wp-filter-open').click();
        await page.locator('.wp-chip[data-wp-chip-group="role"][data-wp-chip="server"]').click();
        expect(await apply.textContent()).toBe('Show 1 project');
        await page.locator('.wp-chip[data-wp-chip-group="role"][data-wp-chip="server"]').click();
        // Two products: the union of their closures.
        await page.locator('.wp-chip[data-wp-chip-group="product"][data-wp-chip="helper"]').click();
        expect(await apply.textContent()).toBe('Show 6 projects');
        await page.locator('.wp-chip[data-wp-chip-group="runtime"][data-wp-chip="angular"]').click();
        expect(await apply.textContent()).toBe('Show 1 project');
        await page.locator('.wp-chip[data-wp-chip-group="runtime"][data-wp-chip="angular"]').click();
        await apply.click();
        expect(await fixture.names(page)).not.toContain('orphan');
        expect((await fixture.names(page)).length).toBe(6);
        await page.locator('#wp-filter-pills [data-wp-pill="product:helper"] button').click();
        expect(await fixture.names(page)).toEqual(['lang-apis', 'lang-svr', 'lang-web', 'model']);
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-filter-clear').click();
        expect(await page.locator('.wp-chip[data-wp-chip-group="product"][aria-pressed="true"]').count()).toBe(0);
        await apply.click();
        expect(await fixture.names(page)).toEqual(Object.keys(GRAPH).sort());
        expect(await page.locator('#wp-filter-badge').isVisible()).toBe(false);
        await page.close();
    });

    it('colors by product on key 4: one product solid, every product neutral, none dashed white', async () => {
        const palette = new ProductPalette(['helper', 'lang']);
        const page = await fixture.open('1179-product-mode', fixture.architecture(GRAPH));
        const shape = (id: string): Locator => fixture.node(page, id).locator('polygon').first();
        await page.evaluate((): void => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('4');
        await expect.poll(() => shape('lang-svr').getAttribute('fill')).toBe(palette.colorOf('lang').color);
        expect(page.url()).toMatch(/#product$/);
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Product');
        expect(await shape('help-svr').getAttribute('fill')).toBe(palette.colorOf('helper').color);
        expect(await shape('model').getAttribute('fill')).toBe(PRODUCT_SHARED_FILL);
        expect(await shape('orphan').getAttribute('fill')).toBe(PRODUCT_NONE_FILL);
        expect(await shape('orphan').getAttribute('stroke-dasharray')).not.toBeNull();
        const legend = page.locator('#wp-side [data-wp-legend-mode="product"]');
        expect(await legend.isVisible()).toBe(true);
        expect(await legend.textContent()).toContain('lang · 4');
        expect(await legend.textContent()).toContain('3 only lang');
        expect(await legend.textContent()).toContain('shared by every product · 1');
        expect(await legend.textContent()).toContain('no product · 1');
        await page.close();
    });

    it('hides the Product group and disables the mode where nothing declares a product', async () => {
        const page = await fixture.open('1179-no-products', fixture.architecture(FilterFixture.wide()));
        expect(await page.locator('#wp-product-group').count()).toBe(0);
        expect(await page.locator('.wp-mode[data-wp-mode="product"]').isDisabled()).toBe(true);
        await page.evaluate((): void => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('4');
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Runtime');
        await page.close();
    });

    it('runtime: chips narrow to a product and keep its cross-product callees, queues, clocks and systems', async () => {
        const runtime: RuntimeGraph = FilterFixture.runtime();
        runtime.services['producer'] = { ...runtime.services['producer'], products: ['lang'] };
        // consumer is helper's, but lang's producer reaches it through the queue.
        runtime.services['consumer'] = { ...runtime.services['consumer'], products: ['helper', 'lang'] };
        runtime.services['unrelated'] = { ...runtime.services['unrelated'], products: ['helper'] };
        const html = new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(generateRuntimeRenderModel(runtime), 'Runtime', runtime);
        const page = await fixture.open('1179-runtime-products', html);
        const full = await fixture.names(page);
        expect(await page.locator('#wp-product-group .wp-chip').allTextContents()).toEqual(['helper', 'lang']);
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-product-group [data-wp-chip="lang"]').click();
        await page.locator('#wp-filter-apply').click();
        await expect
            .poll(() => fixture.names(page))
            .toEqual(['consumer', 'cron__SweepApi_run', 'external__@vendor/api', 'producer', 'queue__TaskApi_send', 'system__db']);
        expect(await page.locator('#wp-product-group [data-wp-chip="lang"]').getAttribute('aria-pressed')).toBe('true');
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-product-group [data-wp-chip="helper"]').click();
        await page.locator('#wp-filter-apply').click();
        await expect.poll(async () => (await fixture.names(page)).includes('unrelated')).toBe(true);
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-product-group [data-wp-chip="lang"]').click();
        await page.locator('#wp-product-group [data-wp-chip="helper"]').click();
        await page.locator('#wp-filter-apply').click();
        await expect.poll(() => fixture.names(page)).toEqual(full);
        await page.close();
    });

    it('runtime: no chip row when no service belongs to a product', async () => {
        const runtime = FilterFixture.runtime();
        const html = new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(generateRuntimeRenderModel(runtime), 'Runtime', runtime);
        const page = await fixture.open('1179-runtime-no-products', html);
        expect(await page.locator('#wp-product-filter').count()).toBe(0);
        await page.close();
    });
});
