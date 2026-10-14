import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { BrowserFixture } from './graph-browser-fixture';
import { FilterFixture } from './graph-filter-fixture';
import { RuntimeLayoutFixture } from './runtime-layout-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';

/** Verify the shipped WASM engine and queue-cylinder postprocessing, including browser rebuilds. */
describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('runtime layout in file:// Chromium', () => {
    const browser = new BrowserFixture(path.resolve('.webpieces/1236-browser-evidence'));
    const fixture = new RuntimeLayoutFixture();
    const model = fixture.model();
    beforeAll(() => browser.start());
    afterAll(async () => browser.browser?.close());

    async function check(page: Page): Promise<void> {
        const centers = await page.locator('#graph g.node:not(.wp-layout)').evaluateAll((nodes) =>
            nodes.map((node) => {
                const box = (node as SVGGElement).getBBox();
                return [node.querySelector('title')!.textContent!, box.y + box.height / 2] as const;
            }),
        );
        const rows = new Map(centers);
        for (const upper of model.bands) {
            for (const lower of model.bands.filter((band) => band.level < upper.level)) {
                for (const from of upper.nodeNames.filter((name) => rows.has(name))) {
                    for (const to of lower.nodeNames.filter((name) => rows.has(name))) {
                        expect(rows.get(from)!).toBeLessThan(rows.get(to)!);
                    }
                }
            }
        }
        for (const [service, queue] of [
            ['reports-dispatcher', 'queue__ReportsDispatcherApi'],
            ['ai-chat', 'queue__WhatsAppApi'],
        ]) {
            if (!rows.has(service)) continue;
            expect(rows.get(service)!).toBeLessThan(rows.get(queue)!);
            for (const edge of model.edges.filter(
                (edge) =>
                    (edge.from === service && edge.to === queue) ||
                    (edge.from === queue && edge.to === service),
            )) {
                expect(await page.locator(`#${edge.id} path`).count()).toBeGreaterThan(0);
            }
            expect(await browser.node(page, queue).locator('path').count()).toBe(2);
        }
    }

    it('preserves rows, badges and both self-queue arrows through color-mode changes and filtering', async () => {
        const html = new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(model, 'Runtime layout regression #1236', fixture.graph);
        const page = await browser.open('runtime-layout', html);
        await check(page);
        expect(await browser.node(page, 'queue__PublicWebhooksApi').textContent()).toMatch(
            /L3\s+PublicWebhooksApi queue/,
        );
        await browser.mode(page, 'product');
        await check(page);
        await browser.filter(page, 'reports-dispatcher');
        await check(page);
        expect(await browser.names(page)).toContain('queue__ReportsDispatcherApi');
        await page.close();
    });
});
