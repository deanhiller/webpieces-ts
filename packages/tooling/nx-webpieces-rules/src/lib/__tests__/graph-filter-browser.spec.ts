import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { FilterFixture } from './graph-filter-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';
import { DiDesign, DiGraph, DiNode } from '../di-graph/model';
import { generateDesignHTML } from '../di-graph/design-visualizer';
import { generateRuntimeRenderModel } from '../runtime-visualizer';
import { loadBlessedGraph } from '../graph-loader';
import { ResponsibilitiesRenderer } from '../graph-responsibilities';
import type { EnhancedGraph } from '../graph-sorter';
import type { GraphRenderModel, RenderEdge } from '../graph-render-model';

/** Opt-in browser suite: WP_GRAPH_VIZ_JS supplies Viz 3; the cross-page test additionally uses
 * WP_GRAPH_VIZ2_JS and WP_GRAPH_VIZ2_RENDER_JS for design's pinned Viz 2.1.2 scripts. */
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
        await page.route('https://cdn.jsdelivr.net/**', (route) => {
            if (route.request().url().includes('viz.js@2.1.2/')) {
                const source = route.request().url().endsWith('/full.render.js')
                    ? process.env.WP_GRAPH_VIZ2_RENDER_JS!
                    : process.env.WP_GRAPH_VIZ2_JS!;
                return route.fulfill({
                    contentType: 'application/javascript',
                    body: fs.readFileSync(source, 'utf8'),
                });
            }
            return route.fulfill({
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
            });
        });
        await page.goto(`file://${file}`);
        await page.locator('g.wp-node-clickable').first().waitFor();
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

    async foreground(page: Page, model: GraphRenderModel, nodes: Set<string>): Promise<void> {
        expect(await this.names(page, '#graph g.node.wp-neighbor')).toEqual([...nodes].sort());
        const expected = model.edges
            .filter((edge: RenderEdge) => nodes.has(edge.from) && nodes.has(edge.to))
            .map((edge: RenderEdge) => edge.id)
            .sort();
        expect(
            await page
                .locator('#graph g.edge.wp-hl')
                .evaluateAll((edges: Element[]) => edges.map((edge: Element) => edge.id).sort()),
        ).toEqual(expected);
        await expect
            .poll(() =>
                page
                    .locator('#graph .wp-neighbor, #graph .wp-hl')
                    .evaluateAll((elements: Element[]) =>
                        elements.every(
                            (element: Element) => getComputedStyle(element).opacity === '1',
                        ),
                    ),
            )
            .toBe(true);
    }

    async cards(page: Page): Promise<string[]> {
        return page
            .locator('.wp-resp-card:not(.wp-hidden)')
            .evaluateAll((cards: Element[]) =>
                cards.map((card: Element) => card.getAttribute('data-node')!).sort(),
            );
    }
}

const fixture = new BrowserFixture();
describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('real Viz local-file filtering', () => {
    beforeAll(() => fixture.start());
    afterAll(async () => fixture.browser?.close());

    it.skipIf(!process.env.WP_GRAPH_VIZ2_JS || !process.env.WP_GRAPH_VIZ2_RENDER_JS)(
        'owns pointer and keyboard menu focus on architecture, runtime and design pages',
        async () => {
            const design = new DiDesign('Root', 'controller', 'src/Root.ts');
            design.nodes = ['Root', 'Other'].map(
                (name) => new DiNode(name, name, 'class', 'singleton', 'src/Root.ts', 0),
            );
            const graph = new DiGraph('focus-fixture');
            graph.designs = [design];
            const runtime = new RuntimeHtmlPage(
                () => FilterFixture.client('runtime-visualizer.client.ts'),
                () => FilterFixture.client('graph-filter.client.ts'),
            ).render(
                generateRuntimeRenderModel(FilterFixture.runtime()),
                'Runtime',
                FilterFixture.runtime(),
            );
            const pages = [
                fixture.architecture(FilterFixture.wide()),
                runtime,
                generateDesignHTML(graph),
            ];
            for (const [index, html] of pages.entries()) {
                const page = await fixture.open(`1129-focus-${index}`, html);
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
                const nodes = page.locator('g.wp-node-clickable');
                const first = nodes.first();
                const second = nodes.last();
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
                        await page.evaluate(() =>
                            Number(document.documentElement.dataset.menuOpens),
                        ),
                    ).toBe(round * 3 + 1);
                    expect(
                        await page
                            .locator('#wp-node-menu button')
                            .first()
                            .evaluate((el) => el === document.activeElement),
                    ).toBe(true);
                    await page.keyboard.press('Escape');
                    await second.hover();
                    expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
                        'none',
                    );
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
                await page.mouse.move(0, 0);
                // Tab reaches SVG nodes through the page's normal tab order.
                await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
                for (let step = 0; step < 30; step++) {
                    await page.keyboard.press('Tab');
                    if (await first.evaluate((el) => el === document.activeElement)) break;
                }
                expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
                expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
                    'dashed',
                );
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
                        await first.evaluate(
                            (el) => el === document.activeElement && el.isConnected,
                        ),
                    ).toBe(true);
                    expect(await first.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
                        '2px',
                    );
                }
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
                    await page
                        .locator('#outside-target')
                        .evaluate((el) => el === document.activeElement),
                ).toBe(true);
                expect(await page.locator('#wp-node-menu').count()).toBe(0);
                await page.locator('#outside-target').press('Tab');
                await first.focus();
                await second.focus();
                expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
                    'none',
                );
                expect(await second.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
                    'dashed',
                );
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
                expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
                    'none',
                );
                await page.close();
            }
        },
    );

    it('restores keyboard node identity across redraw, removal and failed replacement', async () => {
        const page = await fixture.open('1129-redraw', fixture.architecture(FilterFixture.wide()));
        const node = fixture.node(page, 'pr-gate');
        for (let round = 0; round < 3; round++) {
            await node.press('Enter');
            const old = await node.elementHandle();
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Filter Unconnected', exact: true })
                .press('Enter');
            expect(await old!.evaluate((el) => el.isConnected)).toBe(false);
            expect(
                await node.evaluate((el) => el === document.activeElement && el.isConnected),
            ).toBe(true);
            await node.press('Space');
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Turn off Filter', exact: true })
                .press('Enter');
            expect(
                await node.evaluate((el) => el === document.activeElement && el.isConnected),
            ).toBe(true);
        }
        await page.evaluate(() => {
            document.documentElement.dataset.failBinding = 'yes';
        });
        // Force a failure after replacement, then verify the old live node regains focus.
        await page.evaluate(() => {
            const wire = WpNodeMenu.wire;
            WpNodeMenu.wire = (svg, items) => {
                if (document.documentElement.dataset.failBinding === 'yes')
                    throw new Error('Injected binding failure');
                wire(svg, items);
            };
        });
        await node.press('Enter');
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Filter Unconnected', exact: true })
            .press('Enter');
        expect(await node.evaluate((el) => el === document.activeElement && el.isConnected)).toBe(
            true,
        );
        await page.evaluate(() => {
            delete document.documentElement.dataset.failBinding;
        });
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
        await fixture.node(page, 'core-mock').focus();
        const removed = await fixture.node(page, 'core-mock').elementHandle();
        await page.evaluate(() => document.getElementById('redraw')!.click());
        expect(await removed!.evaluate((el) => el.isConnected)).toBe(false);
        expect(
            await page.evaluate(
                () =>
                    document.activeElement?.isConnected &&
                    document.activeElement?.classList.contains('wp-keyboard-focus'),
            ),
        ).toBe(true);
        await page.close();
    });

    it('pins all locked nodes and edges during both reported hover chains', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const model = fixture.viz.generateRenderModel(graph);
        const chain = FilterFixture.api().chain(model);
        const locked = chain.nodes('code-rules');
        const page = await fixture.open('1127-lock-hover', fixture.architecture(graph));
        await page.selectOption('#wp-lock', 'code-rules');
        await fixture.foreground(page, model, locked);
        const cards = await fixture.cards(page);
        await fixture.snapshot(page, '1127-lock-before');
        for (const hovered of ['nx-webpieces-rules', 'api-doc-model', 'openapi-generator']) {
            await fixture.node(page, hovered).hover();
            await fixture.foreground(page, model, new Set([...locked, ...chain.nodes(hovered)]));
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(
                ['code-rules', hovered].sort(),
            );
            expect(await page.locator('#wp-lock').inputValue()).toBe('code-rules');
            expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual(['code-rules']);
            expect(
                await fixture
                    .node(page, 'code-rules')
                    .locator('polygon')
                    .first()
                    .evaluate((shape: SVGElement) => getComputedStyle(shape).stroke),
            ).toBe('rgb(178, 106, 0)');
            expect(await fixture.cards(page)).toEqual(cards);
            await fixture.snapshot(page, `1127-hover-${hovered}`);
            await page.mouse.move(0, 0);
            await fixture.foreground(page, model, locked);
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['code-rules']);
            await fixture.snapshot(page, `1127-leave-${hovered}`);
        }
        await page.close();
    });

    it('recomposes Lock changes and unlock while the pointer stays over a node', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const model = fixture.viz.generateRenderModel(graph);
        const chain = FilterFixture.api().chain(model);
        const page = await fixture.open('1127-lock-changes', fixture.architecture(graph));
        await fixture.node(page, 'api-doc-model').hover();
        for (const locked of ['code-rules', 'nx-webpieces-rules', '']) {
            // selectOption changes the control without moving the pointer off the hovered box.
            await page.selectOption('#wp-lock', locked);
            await fixture.foreground(
                page,
                model,
                new Set([...chain.nodes('api-doc-model'), ...chain.nodes(locked)]),
            );
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(
                (locked === '' ? ['api-doc-model'] : ['api-doc-model', locked]).sort(),
            );
        }
        await page.mouse.move(0, 0);
        expect(await page.locator('#graph svg').getAttribute('class')).not.toContain('wp-dim');
        await fixture.node(page, 'code-rules').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Lock', exact: true })
            .click();
        await page.mouse.move(0, 0);
        expect(await page.locator('#wp-lock').inputValue()).toBe('code-rules');
        await fixture.node(page, 'code-rules').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Unlock', exact: true })
            .click();
        expect(await page.locator('#wp-lock').inputValue()).toBe('');
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual([]);
        await page.close();
    });

    it('suspends hidden Lock chains during hover and restores Lock after repeated redraws', async () => {
        const graph = FilterFixture.wide();
        const model = fixture.viz.generateRenderModel(graph);
        const chain = FilterFixture.api().chain(model);
        const page = await fixture.open('1127-filter-hover', fixture.architecture(graph));
        await page.selectOption('#wp-lock', 'code-rules');
        for (let round = 0; round < 2; round++) {
            await fixture.filter(page, 'hook-runtime');
            const retained = await fixture.names(page);
            const cards = await fixture.cards(page);
            await fixture.node(page, 'pr-gate').hover();
            const hover = new Set(
                [...chain.nodes('pr-gate')].filter((id: string) => retained.includes(id)),
            );
            await fixture.foreground(page, model, hover);
            expect(await fixture.names(page)).toEqual(retained);
            expect(await fixture.cards(page)).toEqual(cards);
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['pr-gate']);
            await page.mouse.move(0, 0);
            expect(await page.locator('#graph svg').getAttribute('class')).not.toContain('wp-dim');
            await page.locator('#wp-filter-off').click();
            await fixture.foreground(page, model, chain.nodes('code-rules'));
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['code-rules']);
        }
        await page.selectOption('#wp-lock', 'pr-gate');
        await fixture.filter(page, 'hook-runtime');
        const retained = await fixture.names(page);
        const rows = await Promise.all(retained.map((id: string) => fixture.row(page, id)));
        const cards = await fixture.cards(page);
        await fixture.node(page, 'ai-hook-rules').hover();
        const union = new Set(
            [...chain.nodes('pr-gate'), ...chain.nodes('ai-hook-rules')].filter((id: string) =>
                retained.includes(id),
            ),
        );
        await fixture.foreground(page, model, union);
        expect(await fixture.cards(page)).toEqual(cards);
        expect(await Promise.all(retained.map((id: string) => fixture.row(page, id)))).toEqual(
            rows,
        );
        await page.mouse.move(0, 0);
        await fixture.foreground(
            page,
            model,
            new Set([...chain.nodes('pr-gate')].filter((id: string) => retained.includes(id))),
        );
        await page.close();
    });

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
