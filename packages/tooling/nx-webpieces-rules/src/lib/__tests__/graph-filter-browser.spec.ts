import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from '@playwright/test';
import * as path from 'path';
import { FilterFixture } from './graph-filter-fixture';
import { GraphFocusBrowser } from './graph-focus-browser';
import { BRANCH_LABEL, BrowserFixture, NO_EDGES, impactScan } from './graph-browser-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';
import { DiDesign, DiGraph, DiNode } from '../di-graph/model';
import { generateDesignHTML } from '../di-graph/design-visualizer';
import { generateRuntimeRenderModel } from '../runtime-visualizer';
import { loadBlessedGraph } from '../graph-loader';
import type { EnhancedGraph } from '../graph-sorter';
import type { RenderNode } from '../graph-render-model';
import { ImpactKind, ImpactSidecarData } from '../graph-impact';

const fixture = new BrowserFixture();

/**
 * The Keep connected to / Focus pulldown graph (#1385): two "inbound" boxes on separate chains (one
 * capitalised, for the case-insensitive search), a third box sharing one of their chains, and a loner.
 */
const PICK_GRAPH: EnhancedGraph = {
    'delivery-partner-inbound': { level: 2, dependsOn: ['orders-core'] },
    'Billing-Inbound': { level: 2, dependsOn: ['billing-core'] },
    'admin-portal': { level: 2, dependsOn: ['orders-core'] },
    'orders-core': { level: 1, dependsOn: ['model'] },
    'billing-core': { level: 1, dependsOn: ['model'] },
    model: { level: 0, dependsOn: [] },
    loner: { level: 0, dependsOn: [] },
};

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
            () => FilterFixture.client('graph-visualizer.client.ts'),
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
                await GraphFocusBrowser.verify(page, index);
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
                .getByRole('button', { name: 'Keep connected', exact: true })
                .press('Enter');
            expect(await old!.evaluate((el) => el.isConnected)).toBe(false);
            expect(
                await node.evaluate((el) => el === document.activeElement && el.isConnected),
            ).toBe(true);
            await node.press('Space');
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Stop keeping connected', exact: true })
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
            .getByRole('button', { name: 'Keep connected', exact: true })
            .press('Enter');
        expect(await node.evaluate((el) => el === document.activeElement && el.isConnected)).toBe(
            true,
        );
        await page.evaluate(() => {
            delete document.documentElement.dataset.failBinding;
        });
        await GraphFocusBrowser.removal(page, node, fixture.node(page, 'core-mock'));
        await page.close();
    });

    it('pins all locked nodes and edges during both reported hover chains', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const model = fixture.viz.generateRenderModel(graph);
        const chain = FilterFixture.api().chain(model);
        const locked = chain.nodes('code-rules');
        const page = await fixture.open('1127-lock-hover', fixture.architecture(graph));
        await fixture.focusOnly(page, 'code-rules');
        await fixture.foreground(page, model, locked);
        const cards = await fixture.cards(page);
        await fixture.snapshot(page, '1127-lock-before');
        for (const hovered of ['nx-webpieces-rules', 'api-doc-model', 'openapi-generator']) {
            await fixture.node(page, hovered).hover();
            await fixture.foreground(page, model, new Set([...locked, ...chain.nodes(hovered)]));
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(
                ['code-rules', hovered].sort(),
            );
            expect(await fixture.picks(page, 'focus')).toEqual(['code-rules']);
            expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual(['code-rules']);
            expect(
                await fixture
                    .node(page, 'code-rules')
                    .locator('polygon')
                    .first()
                    .evaluate((shape: SVGElement) => getComputedStyle(shape).stroke),
            ).toBe('rgb(139, 60, 240)');
            expect(await fixture.cards(page)).toEqual(cards);
            await fixture.snapshot(page, `1127-hover-${hovered}`);
            await page.mouse.move(0, 0);
            await fixture.foreground(page, model, locked);
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['code-rules']);
            await fixture.snapshot(page, `1127-leave-${hovered}`);
        }
        await page.close();
    });

    it('recomposes Focus picks and Esc-clear while the pointer stays over a node', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const model = fixture.viz.generateRenderModel(graph);
        const chain = FilterFixture.api().chain(model);
        const page = await fixture.open('1127-lock-changes', fixture.architecture(graph));
        await fixture.node(page, 'api-doc-model').hover();
        // The keyboard changes Focus without moving the pointer off the hovered box: / opens the
        // search, Enter picks the first match, Esc closes the pulldown.
        const picked: string[] = [];
        for (const id of ['code-rules', 'nx-webpieces-rules']) {
            await page.keyboard.press('/');
            await page.keyboard.type(id);
            await page.keyboard.press('Enter');
            await page.keyboard.press('Escape');
            picked.push(id);
            await fixture.foreground(
                page,
                model,
                new Set([...chain.nodes('api-doc-model'), ...picked.flatMap((p: string) => [...chain.nodes(p)])]),
            );
            expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['api-doc-model', ...picked].sort());
            expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual([...picked].sort());
        }
        // Esc with no pulldown open clears Focus; the hover chain stays.
        await page.keyboard.press('Escape');
        await fixture.foreground(page, model, chain.nodes('api-doc-model'));
        expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['api-doc-model']);
        expect(await fixture.picks(page, 'focus')).toEqual([]);
        await page.mouse.move(0, 0);
        expect(await page.locator('#graph svg').getAttribute('class')).not.toContain('wp-dim');
        await fixture.node(page, 'code-rules').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Add to Focus', exact: true })
            .click();
        await page.mouse.move(0, 0);
        expect(await fixture.picks(page, 'focus')).toEqual(['code-rules']);
        await fixture.node(page, 'code-rules').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Remove from Focus', exact: true })
            .click();
        expect(await fixture.picks(page, 'focus')).toEqual([]);
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual([]);
        await page.close();
    });

    it('suspends hidden Lock chains during hover and restores Lock after repeated redraws', async () => {
        const graph = FilterFixture.wide();
        const model = fixture.viz.generateRenderModel(graph);
        const chain = FilterFixture.api().chain(model);
        const page = await fixture.open('1127-filter-hover', fixture.architecture(graph));
        await fixture.focusOnly(page, 'code-rules');
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
        await fixture.focusOnly(page, 'pr-gate');
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
        await fixture.focusOnly(page, 'hook-runtime');
        const lockNames = await fixture.names(page, '#graph g.node.wp-neighbor');
        await fixture.focusOnly(page, 'nx-webpieces-rules');
        await fixture.filter(page, 'hook-runtime');
        expect(await fixture.names(page)).toEqual(lockNames);
        expect(
            parseFloat((await page.locator('#graph svg').getAttribute('width')) ?? '0'),
        ).toBeLessThan(fullWidth / 2);
        expect(await fixture.picks(page, 'focus')).toEqual(['nx-webpieces-rules']);
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
        await fixture.node(page, 'hook-runtime').press('Enter');
        expect(
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Stop keeping connected', exact: true })
                .count(),
        ).toBe(1);
        await page.keyboard.press('Escape');
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(true);
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page)).toEqual(fullNames);
        expect(await page.locator('#graph svg').getAttribute('class')).toContain('wp-dim');
        await fixture.focusOnly(page, '');
        expect(await fixture.markup(page)).toBe(original);
        await fixture.snapshot(page, 'architecture-restored');
        for (let round = 0; round < 3; round++) {
            await fixture.filter(page, 'hook-runtime');
            await fixture.node(page, 'hook-runtime').click();
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Stop keeping connected', exact: true })
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
        await fixture.focusOnly(page, 'hook-runtime');
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
        expect(await fixture.picks(page, 'focus')).toEqual(['hook-runtime']);
        await page.evaluate(() => {
            delete document.documentElement.dataset.failBinding;
        });
        await page.locator('#wp-filter-off').click();
        await fixture.node(page, 'hook-runtime').click();
        expect(
            await page
                .locator('#wp-node-menu')
                .getByRole('button', { name: 'Remove from Focus', exact: true })
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
    it('shows the graph on first paint at 1440x900, with every control in the drawer', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const page = await fixture.open('1155-first-paint', fixture.architecture(graph));
        await page.setViewportSize({ width: 1440, height: 900 });
        const svg = await page.locator('#graph svg').boundingBox();
        expect(svg!.y).toBeLessThan(120);
        expect(svg!.x).toBeLessThan(320);
        const zoom = await page.locator('.wp-navigation.wp-zoom').boundingBox();
        expect(zoom!.x + zoom!.width).toBeGreaterThan(1300);
        expect(zoom!.y + zoom!.height).toBeGreaterThan(820);
        const legend = await page.locator('#wp-side [data-wp-legend-mode="runtime"]').boundingBox();
        expect(legend!.y).toBeLessThan(450);
        await page.screenshot({ path: path.join(fixture.output, '1155-first-paint.png') });
        await page.close();
    });

    it('switches modes from the Color-by pulldown and the keys, deep-links and remembers', async () => {
        const graph = loadBlessedGraph(process.cwd())!.projects;
        const modes = fixture.viz
            .generateRenderModel(graph)
            .nodes.find((node: RenderNode): boolean => node.id === 'code-rules')!.modes!;
        const fillOf = (dot: string): string => /fillcolor="([^"]+)"/.exec(dot)![1];
        const page = await fixture.open('1155-modes', fixture.architecture(graph));
        const fill = (): Promise<string | null> =>
            fixture.node(page, 'code-rules').locator('polygon').first().getAttribute('fill');
        expect(await page.locator('.wp-mode[aria-checked="true"]').getAttribute('data-wp-mode')).toBe('runtime');
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Runtime');
        expect(await page.locator('#wp-mode-menu').isVisible()).toBe(false);
        expect(await fill()).toBe(fillOf(modes.runtime));
        await fixture.mode(page, 'architecture');
        await expect.poll(fill).toBe(fillOf(modes.architecture));
        expect(await page.locator('#wp-mode-menu').isVisible()).toBe(false);
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Architecture');
        expect(await page.locator('#wp-mode-current-sub').textContent()).toBe('servers · clients · APIs');
        expect(page.url()).toMatch(/#architecture$/);
        expect(await page.locator('#wp-crumb').textContent()).toContain('Architecture');
        expect(await page.locator('#wp-side [data-wp-legend-mode="architecture"]').isVisible()).toBe(true);
        expect(await page.locator('#wp-side [data-wp-legend-mode="runtime"]').isVisible()).toBe(false);
        // No sidecar beside this page: Impact is disabled, with its one-line reason.
        expect(await page.locator('.wp-mode[data-wp-mode="impact"]').isDisabled()).toBe(true);
        expect(await page.locator('#wp-impact-reason').textContent()).toContain('No impact data');
        await page.evaluate((): void => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('1');
        await expect.poll(fill).toBe(fillOf(modes.runtime));
        // The node menu no longer carries a Mode submenu: the drawer is the one place to switch.
        await fixture.node(page, 'code-rules').locator('text').first().click();
        expect(await page.locator('#wp-node-menu').getByRole('button', { name: /^Mode/ }).count()).toBe(0);
        await page.keyboard.press('Escape');
        await page.keyboard.press('2');
        await expect.poll(fill).toBe(fillOf(modes.architecture));
        // Remembered per viewer: a fresh load with no hash comes back in Architecture.
        await page.goto(page.url().split('#')[0]);
        await page.locator('g.wp-node-clickable').first().waitFor();
        expect(await page.locator('.wp-mode[aria-checked="true"]').getAttribute('data-wp-mode')).toBe('architecture');
        // ...and a deep link wins over the remembered choice.
        await page.goto(`${page.url().split('#')[0]}#runtime`);
        await page.locator('g.wp-node-clickable').first().waitFor();
        expect(await page.locator('.wp-mode[aria-checked="true"]').getAttribute('data-wp-mode')).toBe('runtime');
        await page.close();
    });

    it('renders every runtime combination through real Graphviz, insets and plates included', async () => {
        const graph: EnhancedGraph = {
            'portal-web': { level: 3, dependsOn: ['ui-kit'], framework: ['angular'], role: 'client' },
            'mobile-app': { level: 3, dependsOn: ['shared-hooks'], framework: ['react-native'], role: 'client' },
            'jobs-svr': { level: 3, dependsOn: ['server-auth'], framework: ['express'], role: 'server' },
            'ui-kit': { level: 2, dependsOn: ['model'], framework: ['angular', 'browser'], role: 'lib' },
            'shared-hooks': { level: 2, dependsOn: ['model'], framework: ['react', 'react-native'], role: 'lib' },
            'server-auth': { level: 2, dependsOn: ['model'], framework: ['express', 'node'], role: 'designed-lib' },
            'web+rn': { level: 1, dependsOn: ['model'], framework: ['browser', 'react-native'], role: 'api-lib' },
            model: { level: 0, dependsOn: [], framework: ['browser', 'node', 'react-native'], role: 'lib' },
            '<odd & "name">': { level: 0, dependsOn: [], role: 'lib' },
        };
        const page = await fixture.open('1155-runtime-combos', fixture.architecture(graph));
        expect(await fixture.names(page)).toEqual(Object.keys(graph).sort());
        expect(await page.locator('#wp-graph-error').isVisible()).toBe(false);
        for (const legend of ['browser', 'node', 'react-native', 'angular', 'react', 'express', 'multi', 'none'])
            expect(await page.locator(`#wp-side [data-wp-legend="${legend}"]`).count()).toBe(1);
        await page.screenshot({ path: path.join(fixture.output, '1155-runtime-combos.png') });
        await fixture.mode(page, 'architecture');
        await expect.poll(() => page.locator('#wp-crumb').textContent()).toContain('Architecture');
        expect(await page.locator('#wp-graph-error').isVisible()).toBe(false);
        await page.screenshot({ path: path.join(fixture.output, '1155-architecture-combos.png') });
        await page.close();
    });

    it('keeps the UNION of every Keep-connected pick, never shrinking, until Clear all (#1385)', async () => {
        const page = await fixture.open('1385-keep', fixture.architecture(PICK_GRAPH));
        const full = await fixture.names(page);
        expect(await page.locator('#wp-keep-chips').textContent()).toBe('None (off)');
        await fixture.pick(page, 'keep', 'delivery-partner-inbound');
        const one = await fixture.names(page);
        expect(one).toEqual(['delivery-partner-inbound', 'model', 'orders-core']);
        await fixture.pick(page, 'keep', 'Billing-Inbound');
        const two = await fixture.names(page);
        expect(two).toEqual(['Billing-Inbound', 'billing-core', 'delivery-partner-inbound', 'model', 'orders-core']);
        // Adding a pick only ever grows the graph.
        expect(one.every((id: string): boolean => two.includes(id))).toBe(true);
        expect(await fixture.picks(page, 'keep')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-keep-count').textContent()).toBe('2 selected');
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(true);
        expect(await page.locator('#wp-filter-anchor').textContent()).toBe('Billing-Inbound, delivery-partner-inbound');
        expect(await fixture.names(page, '#graph g.node.wp-filter-anchor')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        // The box menu removes just that one pick.
        await fixture.node(page, 'delivery-partner-inbound').locator('text').first().click();
        await page.locator('#wp-node-menu').getByRole('button', { name: 'Stop keeping connected', exact: true }).click();
        expect(await fixture.names(page)).toEqual(['Billing-Inbound', 'billing-core', 'model']);
        await fixture.pick(page, 'keep', 'admin-portal');
        await fixture.clearPicks(page, 'keep');
        expect(await fixture.names(page)).toEqual(full);
        expect(await page.locator('#wp-keep-chips').textContent()).toBe('None (off)');
        expect(await page.locator('#wp-filter-status').isVisible()).toBe(false);
        await page.close();
    });

    it('lights the union of every Focus pick, outlines each, and suspends a hidden one (#1385)', async () => {
        const model = fixture.viz.generateRenderModel(PICK_GRAPH);
        const chain = FilterFixture.api().chain(model);
        const page = await fixture.open('1385-focus', fixture.architecture(PICK_GRAPH));
        // A clicked pick keeps the pulldown open with its query, ready for the next pick.
        await page.locator('#wp-focus-trigger').click();
        await page.locator('#wp-focus-search').fill('inbound');
        await page.locator('#wp-focus-list .wp-multi-option[data-wp-option="delivery-partner-inbound"]').click();
        expect(await page.locator('#wp-focus-pop').isVisible()).toBe(true);
        expect(await page.locator('#wp-focus-search').inputValue()).toBe('inbound');
        await page.locator('#wp-focus-list .wp-multi-option[data-wp-option="Billing-Inbound"]').click();
        await page.keyboard.press('Escape');
        await fixture.foreground(page, model, new Set([...chain.nodes('delivery-partner-inbound'), ...chain.nodes('Billing-Inbound')]));
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-crumb').textContent()).toContain('Focus: Billing-Inbound, delivery-partner-inbound');
        const rows = await fixture.names(page);
        // Keep connected to hides both focused boxes: no relit chain, both chips say "hidden".
        await fixture.pick(page, 'keep', 'admin-portal');
        expect(await fixture.names(page)).toEqual(['admin-portal', 'model', 'orders-core']);
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual([]);
        expect((await page.locator('#graph svg').getAttribute('class')) ?? '').not.toContain('wp-dim');
        expect(await fixture.picks(page, 'focus')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-focus-chips .wp-multi-chip-hidden').count()).toBe(2);
        expect(await page.locator('#wp-focus-chips').textContent()).toContain('hidden');
        // Focus offers only the boxes drawn after Filter and Keep connected to.
        await page.locator('#wp-focus-trigger').click();
        expect(await page.locator('#wp-focus-list .wp-multi-option:visible').evaluateAll((els: Element[]) => els.map((el: Element) => (el as HTMLElement).dataset['wpOption']))).toEqual(['admin-portal', 'model', 'orders-core']);
        await page.keyboard.press('Escape');
        // Visible again: both relight, at their old rows.
        await fixture.clearPicks(page, 'keep');
        expect(await fixture.names(page)).toEqual(rows);
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-focus-chips .wp-multi-chip-hidden').count()).toBe(0);
        await fixture.clearPicks(page, 'focus');
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual([]);
        expect(await page.locator('#wp-focus-chips').textContent()).toBe('None (off)');
        await page.close();
    });

    it('searches anywhere in a name, picks with the keyboard, and closes or clears on Esc (#1385)', async () => {
        const page = await fixture.open('1385-search', fixture.architecture(PICK_GRAPH));
        const order = await page.locator('#wp-focus-list .wp-multi-option').evaluateAll((els: Element[]) => els.map((el: Element) => (el as HTMLElement).dataset['wpOption']));
        expect(order).toEqual(['admin-portal', 'billing-core', 'Billing-Inbound', 'delivery-partner-inbound', 'loner', 'model', 'orders-core']);
        await page.evaluate((): void => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('/');
        expect(await page.locator('#wp-focus-pop').isVisible()).toBe(true);
        expect(await page.locator('#wp-focus-search').evaluate((el: Element): boolean => el === document.activeElement)).toBe(true);
        const shown = (): Promise<(string | undefined)[]> =>
            page.locator('#wp-focus-list .wp-multi-option:visible').evaluateAll((els: Element[]) => els.map((el: Element) => (el as HTMLElement).dataset['wpOption']));
        // Case-insensitive substring: "INBOUND" finds both inbound boxes, with the match marked.
        await page.keyboard.type('INBOUND');
        expect(await shown()).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-focus-list .wp-multi-option:visible mark').allTextContents()).toEqual(['Inbound', 'inbound']);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        expect(await fixture.picks(page, 'focus')).toEqual(['delivery-partner-inbound']);
        // The query stays after a toggle, so the next match is one keystroke away.
        expect(await page.locator('#wp-focus-search').inputValue()).toBe('INBOUND');
        expect(await shown()).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        expect(await fixture.picks(page, 'focus')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-focus-count').textContent()).toBe('2 selected');
        // Space toggles only while the query is empty.
        await page.locator('#wp-focus-search').fill('');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Space');
        expect(await fixture.picks(page, 'focus')).toEqual(['admin-portal', 'Billing-Inbound', 'delivery-partner-inbound']);
        expect(await fixture.names(page, '#graph g.node.wp-locked')).toEqual(['Billing-Inbound', 'admin-portal', 'delivery-partner-inbound']);
        expect(await page.locator('#wp-crumb').textContent()).toContain('Focus: admin-portal, Billing-Inbound +1');
        // A chip's ✕ removes that one pick.
        await page.locator('#wp-focus-chips [data-wp-pick="admin-portal"] button').click();
        expect(await fixture.picks(page, 'focus')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        // Esc closes the open pulldown and keeps Focus; Esc again clears it.
        await page.locator('#wp-focus-search').focus();
        await page.keyboard.press('Escape');
        expect(await page.locator('#wp-focus-pop').isVisible()).toBe(false);
        expect(await fixture.picks(page, 'focus')).toEqual(['Billing-Inbound', 'delivery-partner-inbound']);
        await page.keyboard.press('Escape');
        expect(await fixture.picks(page, 'focus')).toEqual([]);
        expect(await page.locator('#wp-focus-chips').textContent()).toBe('None (off)');
        await page.close();
    });

    it('ships no Lock switch, Hide unconnected switch or Lock menu item in either viewer (#1385)', async () => {
        const runtime = new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(generateRuntimeRenderModel(FilterFixture.runtime()), 'Runtime', FilterFixture.runtime());
        for (const [name, html, box] of [
            ['1385-none-architecture', fixture.architecture(PICK_GRAPH), 'model'],
            ['1385-none-runtime', runtime, 'producer'],
        ]) {
            const page = await fixture.open(name, html);
            expect(await page.locator('#wp-lock, #wp-lock-toggle, #wp-filter-toggle').count()).toBe(0);
            expect(await page.locator('#wp-side').innerText()).not.toMatch(/\bLock\b|Hide unconnected/);
            await fixture.node(page, box).locator('text').first().click();
            const labels = await page.locator('#wp-node-menu button').allTextContents();
            expect(labels).toEqual(expect.arrayContaining(['Add to Focus', 'Keep connected']));
            expect(labels.join(' ')).not.toMatch(/\bLock\b|Unlock|Filter Unconnected|Turn off Filter/);
            await page.close();
        }
    });

    it('enables Impact from the sidecar: touched, affected, build input and untouched shades', async () => {
        const graph = FilterFixture.wide();
        const page = await fixture.openWithImpact(
            '1155-impact',
            fixture.architecture(graph),
            new ImpactSidecarData(
                [
                    impactScan(
                        ImpactKind.BRANCH,
                        BRANCH_LABEL,
                        ['rules-config'],
                        ['hook-runtime', 'pr-gate'],
                        ['repo-workflow-core', 'tooling-common'],
                        2,
                        ['repo-workflow-core', 'tooling-common'],
                    ),
                ],
                ImpactKind.BRANCH,
                NO_EDGES,
            ),
        );
        await fixture.mode(page, 'impact');
        // One scan: no toggle anywhere, and the note names the comparison.
        expect(await page.locator('[data-wp-impact-kinds]:visible').count()).toBe(0);
        expect(await page.locator('#wp-mode-current-sub').textContent()).toBe('what changed');
        const shape = (id: string): Locator => fixture.node(page, id).locator('polygon').first();
        await expect.poll(() => shape('rules-config').getAttribute('fill')).toBe('#f5a524');
        expect(await shape('hook-runtime').getAttribute('fill')).toBe('#fde3b0');
        expect(await shape('hook-runtime').getAttribute('stroke')).toBe('#f5a524');
        expect(await shape('tooling-common').getAttribute('fill')).toBe('#e3e9f2');
        expect(await shape('tooling-common').getAttribute('stroke-dasharray')).not.toBeNull();
        expect(await shape('core-mock').getAttribute('fill')).toBe('#eef0f4');
        expect(await page.locator('#wp-side [data-wp-impact-note]').textContent()).toContain(
            `${BRANCH_LABEL}: 1 changed · 2 dependents · 2 dependencies`,
        );
        await page.screenshot({ path: path.join(fixture.output, '1155-impact.png') });
        await page.close();
    });

    it('filters by change scope, runtime and role — intersected — keeping every L-row (#1158)', async () => {
        const graph: EnhancedGraph = {
            'portal-web': { level: 3, dependsOn: ['ui-kit'], framework: ['browser', 'angular'], role: 'client' },
            'jobs-svr': { level: 3, dependsOn: ['server-auth'], framework: ['node', 'express'], role: 'server' },
            'ui-kit': { level: 2, dependsOn: ['model'], framework: ['browser', 'angular'], role: 'lib' },
            'server-auth': { level: 2, dependsOn: ['model'], framework: ['node'], role: 'lib' },
            api: { level: 1, dependsOn: ['model'], framework: ['browser', 'node'], role: 'api-lib' },
            model: { level: 0, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
        };
        const page = await fixture.openWithImpact(
            '1158-filter',
            fixture.architecture(graph),
            new ImpactSidecarData(
                [impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['ui-kit'], ['portal-web'], ['model'], 1, ['model'])],
                ImpactKind.BRANCH,
                NO_EDGES,
            ),
        );
        const top = await fixture.row(page, 'portal-web');
        await page.locator('#wp-filter-open').click();
        const count = (scope: string): Promise<string | null> =>
            page.locator(`[data-wp-scope-count="${scope}"]`).textContent();
        expect([await count('everything'), await count('changed'), await count('dependents'), await count('dependencies'), await count('build')])
            .toEqual(['6', '1', '2', '2', '3']);
        await page.locator('.wp-chip[data-wp-chip="node"]').click();
        await page.locator('.wp-chip[data-wp-chip="lib"]').click();
        expect(await page.locator('#wp-filter-apply').textContent()).toBe('Show 2 projects');
        await page.locator('#wp-filter-apply').click();
        expect(await page.locator('#wp-filter-pop').isVisible()).toBe(false);
        // node AND lib: the two groups intersect.
        expect(await fixture.names(page)).toEqual(['model', 'server-auth']);
        // L0 stays the bottom row; the emptied L3 and L1 are thin labeled bands, not removed.
        expect(await fixture.row(page, 'model')).toBeGreaterThan(await fixture.row(page, 'server-auth'));
        expect(await page.locator('#graph g.wp-empty-level').allTextContents()).toEqual(
            expect.arrayContaining([expect.stringContaining('L3'), expect.stringContaining('L1')]),
        );
        expect(await page.locator('#graph g.wp-empty-level').count()).toBe(2);
        expect(await fixture.row(page, 'model')).toBeGreaterThan(top);
        // Edges between remaining boxes stay drawn.
        expect(await page.locator('#graph g.edge').count()).toBe(1);
        expect(await page.locator('#wp-filter-badge').textContent()).toBe('2');
        expect(await page.locator('#wp-filter-pills .wp-pill').count()).toBe(2);
        // A pill's ✕ removes just that filter.
        await page.locator('#wp-filter-pills [data-wp-pill="runtime:node"] button').click();
        expect(await fixture.names(page)).toEqual(['model', 'server-auth', 'ui-kit']);
        expect(await page.locator('#wp-filter-badge').textContent()).toBe('1');
        // Change scope intersects too: "Changed + dependencies" = ui-kit + model, still only libs.
        await page.locator('#wp-filter-open').click();
        await page.locator('input[name="wp-scope"][value="dependencies"]').check();
        await page.locator('#wp-filter-apply').click();
        expect(await fixture.names(page)).toEqual(['model', 'ui-kit']);
        expect(await page.locator('#wp-filter-pills').textContent()).toContain('Changed + dependencies');
        await page.screenshot({ path: path.join(fixture.output, '1158-filter.png') });
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-filter-clear').click();
        expect(await page.locator('#wp-filter-apply').textContent()).toBe('Show 6 projects');
        await page.locator('#wp-filter-apply').click();
        expect(await fixture.names(page)).toEqual(Object.keys(graph).sort());
        expect(await page.locator('#wp-filter-badge').isVisible()).toBe(false);
        expect(await page.locator('#graph g.wp-empty-level').count()).toBe(0);
        await page.close();
    });

    it('glows and locks only the OUTER box of a nested and of a striped box (#1158)', async () => {
        const graph: EnhancedGraph = {
            'portal-web': { level: 1, dependsOn: ['model'], framework: ['browser', 'angular'], role: 'client' },
            model: { level: 0, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
        };
        const page = await fixture.open('1158-glow', fixture.architecture(graph));
        const strokes = (id: string): Promise<string[]> =>
            fixture
                .node(page, id)
                .locator('polygon, path, ellipse')
                .evaluateAll((shapes: Element[]) => shapes.map((shape: Element) => getComputedStyle(shape).strokeWidth));
        // Nested: outline polygon, base-colored cell polygon, inner rounded <path>.
        expect(await fixture.node(page, 'portal-web').locator('path').count()).toBe(1);
        await fixture.node(page, 'portal-web').hover();
        await expect.poll(() => strokes('portal-web')).toEqual(['5px', '0px', '0px']);
        // Striped: one polygon per stripe, then the unfilled outline LAST — that is what glows.
        await fixture.node(page, 'model').hover();
        await expect.poll(() => strokes('model')).toEqual(['0.5px', '0.5px', '5px']);
        await page.mouse.move(0, 0);
        await fixture.focusOnly(page, 'portal-web');
        await expect.poll(async () => (await strokes('portal-web'))[0]).toBe('3px');
        expect((await strokes('portal-web')).slice(1).every((w: string): boolean => w !== '3px')).toBe(true);
        await page.close();
    });

    it('names the workspace-global cause when nothing is touched but everything is affected (#1158)', async () => {
        const graph = FilterFixture.wide();
        const ids = Object.keys(graph);
        const page = await fixture.openWithImpact(
            '1158-global-cause',
            fixture.architecture(graph),
            new ImpactSidecarData(
                [impactScan(ImpactKind.BRANCH, BRANCH_LABEL, [], ids, [], 2, [], ['pnpm-lock.yaml', 'pnpm-workspace.yaml'])],
                ImpactKind.BRANCH,
                NO_EDGES,
            ),
        );
        await fixture.mode(page, 'impact');
        expect(await page.locator('#wp-side [data-wp-impact-note]').textContent()).toContain(
            'Every project affected: pnpm-lock.yaml, pnpm-workspace.yaml changed (workspace-global inputs)',
        );
        await page.close();
    });

    it('disables the change scope with Impact\'s reason when there is no sidecar (#1158)', async () => {
        const page = await fixture.open('1158-no-impact', fixture.architecture(FilterFixture.wide()));
        await page.locator('#wp-filter-open').click();
        expect(await page.locator('#wp-scope-group').evaluate((el: Element): boolean => (el as HTMLFieldSetElement).disabled)).toBe(true);
        expect(await page.locator('#wp-scope-reason').textContent()).toContain('pnpm arch:visualize');
        await page.locator('.wp-chip[data-wp-chip="lib"]').click();
        await page.locator('#wp-filter-apply').click();
        expect((await fixture.names(page)).length).toBeGreaterThan(0);
        await page.close();
    });

    it('keeps runtime chains through queues/externals and keeps every Focus pick after every redraw', async () => {
        const model = generateRuntimeRenderModel(FilterFixture.runtime());
        const html = new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(model, 'Runtime', FilterFixture.runtime());
        const page = await fixture.open('runtime', html);
        const fullNames = await fixture.names(page);
        await fixture.snapshot(page, 'runtime-before');
        await fixture.node(page, 'unrelated').locator('text').first().click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Add to Focus', exact: true })
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
            .getByRole('button', { name: 'Add to Focus', exact: true })
            .click();
        // "unrelated" is still focused but not drawn, so only consumer lights.
        expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['consumer']);
        expect(await fixture.picks(page, 'focus')).toEqual(['consumer', 'unrelated']);
        await page.locator('#wp-filter-off').click();
        expect(await fixture.names(page, '#graph g.node.wp-focus')).toEqual(['consumer', 'unrelated']);
        await page.close();
    });
});
