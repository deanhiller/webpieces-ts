import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { BrowserFixture } from './graph-browser-fixture';
import { FilterFixture } from './graph-filter-fixture';
import { RuntimeGoalFixture } from './runtime-goal-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';
import { generateRuntimeRenderModel, RuntimeVizOptions, RuntimePageKind } from '../runtime-visualizer';
import { RuntimeGoalComparison } from '../runtime-goal-comparison';
import type { GraphRenderModel, RenderEdge } from '../graph-render-model';
import type { LevelBand } from '../graph-level-bands';

/**
 * Goal vs Current in the shipped WASM engine, opened from file:// (#1239): the existing Color-by
 * dropdown switches to the overlay topology, removals stay drawn, details open from boxes and arrows,
 * Filter and Lock work on the overlay, and switching back restores the page's own graph.
 */
describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('Goal vs Current in file:// Chromium', () => {
    const browser = new BrowserFixture(path.resolve('.webpieces/1239-browser-evidence'));
    const fixture = new RuntimeGoalFixture();
    const options = new RuntimeVizOptions(true, null, '', RuntimePageKind.GOAL);
    const model = generateRuntimeRenderModel(fixture.goal, 'Goal', options);
    model.comparison = new RuntimeGoalComparison().build(fixture.current, fixture.goal, options);
    const overlay = model.comparison.model!;
    beforeAll(() => browser.start());
    afterAll(async () => browser.browser?.close());

    function html(drawn: GraphRenderModel): string {
        return new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(drawn, 'Goal / Proposed Runtime Architecture', fixture.goal, options);
    }

    /** Actual rendered rows: every higher level strictly above every lower one. */
    async function rows(page: Page, drawn: GraphRenderModel): Promise<void> {
        const centers = await page.locator('#graph g.node:not(.wp-layout)').evaluateAll((nodes: Element[]) =>
            nodes.map((node: Element) => {
                const box = (node as SVGGElement).getBBox();
                return [node.querySelector('title')!.textContent!, box.y + box.height / 2] as const;
            }),
        );
        const at = new Map(centers);
        for (const upper of drawn.bands) {
            for (const lower of drawn.bands.filter((band: LevelBand) => band.level < upper.level)) {
                for (const from of upper.nodeNames.filter((id: string) => at.has(id))) {
                    for (const to of lower.nodeNames.filter((id: string) => at.has(id))) expect(at.get(from)!).toBeLessThan(at.get(to)!);
                }
            }
        }
    }

    async function details(page: Page): Promise<string> {
        return (await page.locator('.wp-goal-details').textContent()) ?? '';
    }

    it('switches topology through the existing dropdown, keeps removals visible, and restores the normal view', async () => {
        const page = await browser.open('runtime-goal', html(model));
        expect(await browser.names(page)).not.toContain('stores-manager');
        await browser.mode(page, 'goal');
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Goal vs Current');
        expect(await browser.names(page)).toContain('stores-manager');
        expect(await browser.names(page)).toContain('billing');
        await rows(page, overlay);
        const removedEdge = overlay.edges.find((edge: RenderEdge) => edge.from === 'stores-manager')!;
        expect(await page.locator(`#${removedEdge.id} path`).count()).toBeGreaterThan(0);
        for (const edge of overlay.edges.filter((candidate: RenderEdge) => [candidate.from, candidate.to].includes('queue__ReportsDispatcherApi')))
            expect(await page.locator(`#${edge.id} path`).count()).toBeGreaterThan(0);
        expect(await page.locator('#wp-side [data-wp-legend-mode="goal"]').textContent()).toContain('Current → Goal');
        await browser.snapshot(page, 'goal-vs-current');

        await browser.node(page, 'orders-manager').locator('text').first().click();
        await page.locator('#wp-node-menu').getByRole('button', { name: 'Goal vs Current details', exact: true }).click();
        expect(await details(page)).toMatch(/level: L4 → L5/);
        expect(await details(page)).toContain('outgoing:');
        await page.keyboard.press('Escape');
        await page.locator(`#${removedEdge.id} text`).first().click();
        expect(await details(page)).toContain('Enqueue stores-manager → contract-queue:PublicWebhooksApi — removed');
        await browser.snapshot(page, 'goal-edge-details');

        await browser.mode(page, 'runtime');
        expect(await browser.names(page)).not.toContain('stores-manager');
        expect(await page.locator('.wp-goal-details').isVisible()).toBe(false);
        await rows(page, model);
        await page.close();
    });

    it('filters and locks overlay additions and removals, then restores the overlay', async () => {
        const page = await browser.open('runtime-goal-filter', html(model));
        await browser.mode(page, 'goal');
        await browser.lock(page, 'stores-manager');
        expect(await browser.names(page, '#graph g.node.wp-locked')).toEqual(['stores-manager']);
        await browser.lock(page, '');
        // ai-chat's chain reaches the ADDED orders-manager enqueue, never the removed stores-manager.
        await browser.filter(page, 'ai-chat');
        const kept = await browser.names(page);
        expect(kept).toContain('orders-manager');
        expect(kept).toContain('queue__WhatsAppApi');
        expect(kept).not.toContain('stores-manager');
        await rows(page, overlay);
        await page.locator('#wp-filter-off').click();
        expect(await browser.names(page)).toContain('stores-manager');
        await browser.mode(page, 'product');
        expect(await browser.names(page)).not.toContain('stores-manager');
        await page.close();
    });

    it('says why Goal vs Current is unavailable instead of showing no differences', async () => {
        const bare = generateRuntimeRenderModel(fixture.goal, 'Goal', options);
        const page = await browser.open('runtime-goal-unavailable', html(bare));
        const item = page.locator('#wp-mode-menu .wp-mode[data-wp-mode="goal"]');
        expect(await item.isDisabled()).toBe(true);
        expect(await item.textContent()).toContain('Unavailable:');
        await page.close();
    });
});
