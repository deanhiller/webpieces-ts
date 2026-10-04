import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { FilterFixture } from './graph-filter-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';
import { generateRuntimeRenderModel } from '../runtime-visualizer';
import { loadBlessedGraph } from '../graph-loader';
import { ResponsibilitiesRenderer } from '../graph-responsibilities';
import type { EnhancedGraph } from '../graph-sorter';

/** Opt-in real-browser suite: supply the page's pinned Viz UMD file and installed Chromium. */
class BrowserFixture {
    readonly output = path.resolve('.webpieces/1118-browser-evidence');
    readonly viz = FilterFixture.visualizer();
    browser!: Browser;

    async start(): Promise<void> {
        fs.mkdirSync(this.output, { recursive: true });
        this.browser = await chromium.launch({ headless: true });
    }

    async open(name: string, html: string): Promise<Page> {
        const file = path.join(this.output, `${name}.html`);
        fs.writeFileSync(file, html);
        const page = await this.browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await page.route('https://cdn.jsdelivr.net/**', (route) =>
            route.fulfill({
                contentType: 'application/javascript',
                body:
                    fs.readFileSync(process.env.WP_GRAPH_VIZ_JS!, 'utf8') +
                    `
const realInstance = Viz.instance;
Viz.instance = async () => {
  const viz = await realInstance(); const render = viz.renderSVGElement.bind(viz);
  viz.renderSVGElement = dot => {
    if (document.documentElement.dataset.failRender === 'yes') throw new Error('Injected renderer failure');
    return render(dot);
  };
  return viz;
};`,
            }),
        );
        await page.goto(`file://${file}`);
        await page.locator('#graph svg').waitFor();
        return page;
    }

    architecture(graph: EnhancedGraph): string {
        return this.viz.generateHTML(
            this.viz.generateRenderModel(graph),
            this.viz.designLinks(graph),
            'Architecture',
            this.viz.lockControl(graph),
            new ResponsibilitiesRenderer().generateSection(graph, process.cwd()),
        );
    }

    node(page: Page, id: string): Locator {
        return page.locator('g.node').filter({
            has: page.locator('title', {
                hasText: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            }),
        });
    }

    async names(page: Page, selector = '#graph g.node'): Promise<string[]> {
        return (await page.locator(`${selector} > title`).allTextContents()).sort();
    }

    async filter(page: Page, id: string): Promise<void> {
        await this.node(page, id).locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Filter Unconnected', exact: true })
            .click();
        await page.mouse.move(0, 0);
    }

    async markup(page: Page): Promise<string> {
        return page.locator('#graph svg').evaluate((svg) => {
            const copy = svg.cloneNode(true) as SVGSVGElement;
            copy.querySelectorAll('.wp-focus, .wp-neighbor, .wp-hl').forEach((element) =>
                element.classList.remove('wp-focus', 'wp-neighbor', 'wp-hl'),
            );
            return copy.innerHTML;
        });
    }

    async snapshot(page: Page, name: string): Promise<void> {
        await page.screenshot({
            path: path.join(this.output, `${name}.png`),
            clip: { x: 0, y: 0, width: 1440, height: 1000 },
            animations: 'disabled',
        });
    }

    async row(page: Page, id: string): Promise<number> {
        return Number(await this.node(page, id).locator('text').first().getAttribute('y'));
    }
}

const fixture = new BrowserFixture();
describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('real Viz local-file filtering', () => {
    beforeAll(() => fixture.start());
    afterAll(async () => fixture.browser?.close());

    it('compacts real architecture ranks, preserves hidden Lock/cards and restores repeated rounds', async () => {
        const page = await fixture.open(
            'architecture-wide',
            fixture.architecture(FilterFixture.wide()),
        );
        const original = await fixture.markup(page);
        const fullWidth = parseFloat(
            (await page.locator('#graph svg').getAttribute('width')) ?? '0',
        );
        const fullNames = await fixture.names(page);
        await fixture.snapshot(page, 'architecture-before');
        await page.selectOption('#wp-lock', 'hook-runtime');
        const lockNames = await fixture.names(page, '#graph g.node.wp-neighbor');
        await page.selectOption('#wp-lock', 'nx-webpieces-rules');
        await fixture.filter(page, 'hook-runtime');
        expect(await fixture.names(page)).toEqual(lockNames);
        expect(
            parseFloat((await page.locator('#graph svg').getAttribute('width')) ?? '0'),
        ).toBeLessThan(fullWidth / 2);
        expect(await page.locator('#wp-lock').inputValue()).toBe('nx-webpieces-rules');
        expect((await page.locator('#graph svg').getAttribute('class')) ?? '').not.toContain(
            'wp-dim',
        );
        expect(await page.locator('.wp-resp-card:not(.wp-hidden)').getAttribute('data-node')).toBe(
            'tooling-common',
        );
        const rows = await Promise.all(
            [
                'webpieces-tooling',
                'pr-gate',
                'hook-runtime',
                'rules-config',
                'repo-workflow-core',
                'tooling-common',
            ].map((id) => fixture.row(page, id)),
        );
        expect(rows).toEqual([...rows].sort((a, b) => a - b));
        expect(new Set(rows).size).toBe(6);
        expect(await fixture.row(page, 'pr-gate')).toBe(await fixture.row(page, 'ai-hook-rules'));
        await fixture.snapshot(page, 'architecture-filtered');
        await fixture.node(page, 'pr-gate').hover();
        expect(await fixture.names(page)).toEqual(lockNames);
        expect(await page.locator('.wp-resp-card:not(.wp-hidden)').count()).toBe(1);
        await fixture.node(page, 'pr-gate').press('Enter');
        expect(
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Turn off Filter', exact: true })
                .count(),
        ).toBe(1);
        await page.keyboard.press('Escape');
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(true);
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page)).toEqual(fullNames);
        expect(await page.locator('#graph svg').getAttribute('class')).toContain('wp-dim');
        await page.selectOption('#wp-lock', '');
        expect(await fixture.markup(page)).toBe(original);
        await fixture.snapshot(page, 'architecture-restored');
        for (let round = 0; round < 3; round++) {
            await fixture.filter(page, 'hook-runtime');
            await fixture.node(page, 'pr-gate').click();
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Turn off Filter', exact: true })
                .click();
            expect(await fixture.names(page)).toEqual(fullNames);
            expect(await page.locator('#wp-node-menu').count()).toBe(0);
        }
        await page.close();
    });

    it('retains sparse L5/L2/L0 rows, including an unconstrained bottom leaf', async () => {
        const graph = {
            top: { level: 5, dependsOn: ['middle'] },
            middle: { level: 2, dependsOn: [] },
            bottom: { level: 0, dependsOn: [] },
        };
        const page = await fixture.open('architecture-gaps', fixture.architecture(graph));
        const rows = await Promise.all(
            ['top', 'middle', 'bottom'].map((id) => fixture.row(page, id)),
        );
        expect(rows[0]).toBeLessThan(rows[1]);
        expect(rows[1]).toBeLessThan(rows[2]);
        await fixture.filter(page, 'top');
        expect(await fixture.names(page)).toEqual(['middle', 'top']);
        expect(await fixture.row(page, 'top')).toBeLessThan(await fixture.row(page, 'middle'));
        await page.locator('#wp-filter-off').click();
        expect(await fixture.row(page, 'bottom')).toBe(rows[2]);
        await page.close();
    });

    it('keeps the previous usable SVG and filter after render failures, then recovers', async () => {
        const page = await fixture.open(
            'render-failure',
            fixture.architecture(FilterFixture.wide()),
        );
        const original = await fixture.markup(page);
        await page.evaluate(() => {
            document.documentElement.dataset.failRender = 'yes';
        });
        await fixture.filter(page, 'hook-runtime');
        expect(await fixture.markup(page)).toBe(original);
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(false);
        expect(await page.locator('#wp-graph-error').textContent()).toContain(
            'Injected renderer failure',
        );
        await page.evaluate(() => {
            delete document.documentElement.dataset.failRender;
        });
        await fixture.filter(page, 'hook-runtime');
        const filtered = await fixture.names(page);
        await page.evaluate(() => {
            document.documentElement.dataset.failRender = 'yes';
        });
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page)).toEqual(filtered);
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(true);
        await page.evaluate(() => {
            delete document.documentElement.dataset.failRender;
        });
        await page.locator('#wp-filter-off').click();
        expect(await page.locator('#wp-graph-error').isVisible()).toBe(false);
        expect(await fixture.markup(page)).toBe(original);
        await page.close();
    });

    it('rolls back SVG binding failures without accumulating handlers', async () => {
        const page = await fixture.open(
            'binding-failure',
            fixture.architecture(FilterFixture.wide()),
        );
        await page.selectOption('#wp-lock', 'hook-runtime');
        await fixture.filter(page, 'hook-runtime');
        const original = await fixture.markup(page);
        await page.evaluate(() => {
            const wire = WpNodeMenu.wire;
            WpNodeMenu.wire = (svg, items) => {
                if (document.documentElement.dataset.failBinding === 'yes')
                    throw new Error('Injected binding failure');
                wire(svg, items);
            };
            document.documentElement.dataset.failBinding = 'yes';
        });
        await page.locator('#wp-filter-off').click();
        expect(await fixture.markup(page)).toBe(original);
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(true);
        expect(await page.locator('#wp-lock').inputValue()).toBe('hook-runtime');
        await page.evaluate(() => {
            delete document.documentElement.dataset.failBinding;
        });
        await page.locator('#wp-filter-off').click();
        await fixture.node(page, 'hook-runtime').click();
        expect(
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Unlock', exact: true })
                .count(),
        ).toBe(1);
        await page.close();
    });

    it('handles a single isolated node and a filter retaining the whole graph', async () => {
        const graph = { isolated: { level: 5, dependsOn: [] } };
        const page = await fixture.open('single-node', fixture.architecture(graph));
        await fixture.filter(page, 'isolated');
        expect(await fixture.names(page)).toEqual(['isolated']);
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(true);
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page)).toEqual(['isolated']);
        await page.close();
    });

    it('compacts and restores the large saved architecture snapshot at normal browser zoom', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const page = await fixture.open('architecture-real', fixture.architecture(graph));
        const original = await fixture.names(page);
        const width = parseFloat((await page.locator('#graph svg').getAttribute('width')) ?? '0');
        await fixture.snapshot(page, 'real-before');
        await fixture.filter(page, 'hook-runtime');
        expect((await fixture.names(page)).length).toBeLessThan(original.length);
        expect(
            parseFloat((await page.locator('#graph svg').getAttribute('width')) ?? '0'),
        ).toBeLessThan(width);
        await fixture.snapshot(page, 'real-filtered');
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page)).toEqual(original);
        await fixture.snapshot(page, 'real-restored');
        await page.close();
    });
    it('filters runtime chains through queues/externals and keeps its single-box Lock after every redraw', async () => {
        const model = generateRuntimeRenderModel(FilterFixture.runtime());
        const html = new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
        ).render(model, 'Runtime', FilterFixture.runtime());
        const page = await fixture.open('runtime', html);
        const fullNames = await fixture.names(page);
        await fixture.snapshot(page, 'runtime-before');
        await fixture.node(page, 'unrelated').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Lock', exact: true })
            .click();
        await fixture.filter(page, 'queue__TaskApi_send');
        expect(await fixture.names(page)).toEqual([
            'consumer',
            'cron__SweepApi_run',
            'external__@vendor/api',
            'producer',
            'queue__TaskApi_send',
            'system__db',
        ]);
        expect((await page.locator('#graph svg').getAttribute('class')) ?? '').not.toContain(
            'wp-dim',
        );
        expect(await fixture.node(page, 'queue__TaskApi_send').locator('path').count()).toBe(2);
        expect(await fixture.node(page, 'system__db').getAttribute('class')).not.toContain(
            'wp_queue',
        );
        await fixture.snapshot(page, 'runtime-filtered');
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page)).toEqual(fullNames);
        expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['unrelated']);
        expect(await fixture.node(page, 'queue__TaskApi_send').locator('path').count()).toBe(2);
        await fixture.snapshot(page, 'runtime-restored');
        await fixture.filter(page, 'producer');
        await fixture.node(page, 'consumer').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Lock', exact: true })
            .click();
        expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['consumer']);
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['consumer']);
        await page.close();
    });
});
