import { expect } from 'vitest';
import type { Page, Locator } from '@playwright/test';

/** Real-browser assertions for the shared node menu's independent focus lifecycle. */
export class GraphFocusBrowser {
    static async verify(page: Page, index: number): Promise<void> {
        await GraphFocusBrowser.prepare(page);
        const nodes = page.locator('g.wp-node-clickable');
        const first = nodes.first();
        const second = nodes.last();
        await GraphFocusBrowser.pointer(page, first, second, index);
        await GraphFocusBrowser.keyboard(page, first, second, index);
        await GraphFocusBrowser.outsideAndZoom(page, first, second);
    }

    static async prepare(page: Page): Promise<void> {
        await page.evaluate(() => {
            const open = WpNodeMenu.open;
            WpNodeMenu.open = (node, name, items) => {
                const count = Number(document.documentElement.dataset.menuOpens ?? '0');
                document.documentElement.dataset.menuOpens = String(count + 1);
                open(node, name, items);
            };
            document.querySelectorAll<SVGSVGElement>('svg').forEach((svg) => {
                WpNodeMenu.wire(svg, () => []);
                WpNodeMenu.wire(svg, () => []);
            });
        });
    }

    static async pointer(
        page: Page,
        first: Locator,
        second: Locator,
        index: number,
    ): Promise<void> {
        for (let round = 0; round < 3; round++) {
            await first
                .locator('text:not([data-wp-details])')
                .filter({ hasText: /\S/ })
                .first()
                .click();
            expect(
                await page.locator('#wp-node-menu').count(),
                `page ${index} round ${round}`,
            ).toBe(1);
            expect(
                await page.evaluate(() => Number(document.documentElement.dataset.menuOpens)),
            ).toBe(round * 3 + 1);
            expect(
                await page
                    .locator('#wp-node-menu button')
                    .first()
                    .evaluate((el) => el === document.activeElement),
            ).toBe(true);
            await page.keyboard.press('Escape');
            await second.hover();
            expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
            expect(await page.locator('.wp-keyboard-focus').count()).toBe(0);
            await first
                .locator('text:not([data-wp-details])')
                .filter({ hasText: /\S/ })
                .first()
                .click();
            await second
                .locator('text:not([data-wp-details])')
                .filter({ hasText: /\S/ })
                .first()
                .click();
            expect(await page.locator('#wp-node-menu').count()).toBe(1);
            await page.keyboard.press('Escape');
        }
    }

    static async keyboard(
        page: Page,
        first: Locator,
        second: Locator,
        index: number,
    ): Promise<void> {
        await page.mouse.move(0, 0);
        // Tab reaches SVG nodes through the page's normal tab order.
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        for (let step = 0; step < 30; step++) {
            await page.keyboard.press('Tab');
            if (await first.evaluate((el) => el === document.activeElement)) break;
        }
        expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('dashed');
        if (index === 0) {
            await second.hover();
            await expect
                .poll(() => first.evaluate((el) => getComputedStyle(el).opacity))
                .toBe('0.15');
            expect(await first.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(
                'rgb(123, 31, 162)',
            );
            expect(await first.getAttribute('class')).not.toContain('wp-locked');
            await page.mouse.move(0, 0);
        }
        for (const key of ['Enter', 'Space']) {
            await first.press(key);
            expect(
                await page
                    .locator('#wp-node-menu button')
                    .first()
                    .evaluate((el) => el === document.activeElement),
            ).toBe(true);
            await page.keyboard.press('Escape');
            expect(
                await first.evaluate((el) => el === document.activeElement && el.isConnected),
            ).toBe(true);
            expect(await first.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
        }
    }

    static async outsideAndZoom(page: Page, first: Locator, second: Locator): Promise<void> {
        await first.press('Enter');
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Lock', exact: true })
            .press('Enter');
        expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
        await first.press('Enter');
        await page.evaluate(() => {
            const target = document.createElement('button');
            target.id = 'outside-target';
            target.textContent = 'Outside';
            document.body.prepend(target);
        });
        await page.locator('#outside-target').click();
        expect(
            await page.locator('#outside-target').evaluate((el) => el === document.activeElement),
        ).toBe(true);
        expect(await page.locator('#wp-node-menu').count()).toBe(0);
        await page.locator('#outside-target').press('Tab');
        await first.focus();
        await second.focus();
        expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
        expect(await second.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('dashed');
        await second.evaluate((el) => (el as SVGElement).blur());
        expect(await page.locator('.wp-keyboard-focus').count()).toBe(0);
        await page
            .locator('svg')
            .first()
            .evaluate((svg) => {
                svg.style.transform = 'scale(0.65)';
            });
        await first
            .locator('text:not([data-wp-details])')
            .filter({ hasText: /\S/ })
            .first()
            .click();
        await page.keyboard.press('Escape');
        expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    }

    static async removal(page: Page, node: Locator, removedNode: Locator): Promise<void> {
        // Retain the real filter action, then invoke it while a disconnected-chain node owns focus.
        await page.evaluate(() => {
            const open = WpNodeMenu.open;
            WpNodeMenu.open = (node, name, items) => {
                const action = items.find((item) => item.label === 'Filter Unconnected')!;
                const button = document.createElement('button');
                button.id = 'redraw';
                button.addEventListener('click', () => action.onSelect());
                document.body.appendChild(button);
                open(node, name, items);
            };
        });
        await node.press('Enter');
        await page.keyboard.press('Escape');
        await removedNode.focus();
        const removed = await removedNode.elementHandle();
        await page.evaluate(() => document.getElementById('redraw')!.click());
        expect(await removed!.evaluate((el) => el.isConnected)).toBe(false);
        expect(
            await page.evaluate(
                () =>
                    document.activeElement?.isConnected &&
                    document.activeElement?.classList.contains('wp-keyboard-focus'),
            ),
        ).toBe(true);
    }
}
