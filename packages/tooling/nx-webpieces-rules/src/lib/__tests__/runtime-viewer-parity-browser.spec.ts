import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserFixture, BRANCH_LABEL, impactScan } from './graph-browser-fixture';
import { FilterFixture } from './graph-filter-fixture';
import { RuntimeHtmlPage } from '../runtime-html-page';
import { generateRuntimeRenderModel, RuntimeVizOptions } from '../runtime-visualizer';
import { ImpactKind, ImpactSidecarData } from '../graph-impact';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph } from '../runtime-graph-model';

class RuntimeParityFixture {
    readonly browser = new BrowserFixture(path.resolve('.webpieces/1185-browser-evidence'));
    readonly graph = FilterFixture.runtime();
    readonly projects: EnhancedGraph = {};

    constructor() {
        for (const name of Object.keys(this.graph.services))
            this.graph.services[name] = { ...this.graph.services[name] };
        this.graph.services.producer.role = 'client';
        this.graph.services.producer.level = 3;
        this.graph.services.producer.products = ['shop'];
        this.graph.services.consumer.role = 'server';
        this.graph.services.consumer.level = 2;
        this.graph.services.consumer.implements = ['TaskApi'];
        this.graph.services.consumer.products = ['shop', 'billing'];
        this.graph.services.consumer.wiringImplements = [
            { api: 'TaskApi', conditional: 'TASKS_ENABLED' },
        ];
        this.graph.services.producer.wiringUses = [
            {
                api: 'TaskApi',
                declaredVia: 'shared-client',
                targetService: 'consumer',
                methodsInferred: true,
                conditional: 'TASKS_ENABLED',
            },
        ];
        this.graph.services.unrelated.role = 'server';
        this.graph.services.unrelated.products = ['billing'];
        this.graph.apis.TaskApi = {
            owner: 'task-contracts',
            implementedBy: ['consumer'],
            usedBy: ['producer'],
            type: 'pubsub',
        };
        for (const [name, service] of Object.entries(this.graph.services)) {
            this.projects[name] = {
                level: 0,
                dependsOn: ['shared-client'],
                role: service.role,
                framework: name === 'producer' ? ['browser', 'react'] : ['node', 'express'],
            };
        }
    }

    addLoad(graph: RuntimeGraph, projects: EnhancedGraph): void {
        // Add forty realistic client→service→saved-system chains to stress a laptop-sized canvas.
        for (let index = 0; index < 40; index++) {
            const client = `load/client-${index}`;
            const server = `load/server-${index}`;
            graph.services[client] = {
                level: 3,
                role: 'client',
                implements: [],
                uses: ['LoadApi'],
                dependsOn: [server],
                products: ['load'],
            };
            graph.services[server] = {
                level: 2,
                role: 'server',
                implements: ['LoadApi'],
                uses: [],
                dependsOn: [],
                products: ['load'],
            };
            projects[client] = {
                level: 3,
                role: 'client',
                framework: ['browser', 'react'],
                dependsOn: [server],
            };
            projects[server] = {
                level: 2,
                role: 'server',
                framework: ['node', 'express'],
                dependsOn: [],
            };
            graph.runtimeEdges.push({ from: client, to: server, via: ['LoadApi'], type: 'rpc' });
        }
        graph.apis.LoadApi = {
            owner: 'load-contracts',
            implementedBy: Object.keys(graph.services).filter((name) =>
                name.startsWith('load/server'),
            ),
            usedBy: [],
            type: 'rpc',
        };
    }

    async panels(page: import('@playwright/test').Page, prefix: string): Promise<void> {
        for (const [open, close, name] of [
            ['wp-mode-trigger', 'wp-mode-trigger', 'modes'],
            ['wp-legend-pop', 'wp-legend-close', 'legend'],
            ['wp-help-btn', 'wp-help-close', 'help'],
            ['wp-resp-open', 'wp-resp-close', 'responsibilities'],
        ]) {
            await page.locator(`#${open}`).click();
            await this.browser.snapshot(page, `${prefix}-${name}`);
            await page.locator(`#${close}`).click();
        }
    }

    html(graph: RuntimeGraph = this.graph, projects: EnhancedGraph = this.projects): string {
        const options = new RuntimeVizOptions(true, projects);
        return new RuntimeHtmlPage(
            () => FilterFixture.client('runtime-visualizer.client.ts'),
            () => FilterFixture.client('graph-filter.client.ts'),
            () => FilterFixture.client('graph-visualizer.client.ts'),
        ).render(generateRuntimeRenderModel(graph, 'Runtime', options), 'Runtime', graph, options);
    }
}

describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('runtime viewer parity in file:// Chromium', () => {
    const fixture = new RuntimeParityFixture();
    beforeAll(() => fixture.browser.start());
    afterAll(async () => fixture.browser.browser?.close());

    it('shares the shell and pins complete queue chains; Lock and Hide unconnected stay independent', async () => {
        const page = await fixture.browser.open('1185-runtime-shell', fixture.html());
        expect(await page.locator('#wp-lock-toggle').getAttribute('aria-pressed')).toBe('false');
        await fixture.browser.lock(page, 'producer');
        await page.mouse.move(1400, 900);
        expect(await fixture.browser.names(page, 'g.node.wp-neighbor')).toEqual([
            'consumer',
            'cron__SweepApi_run',
            'external__@vendor/api',
            'producer',
            'queue__TaskApi_send',
            'system__db',
        ]);
        await fixture.browser.node(page, 'unrelated').hover();
        expect(await fixture.browser.names(page, 'g.node.wp-neighbor')).toContain('unrelated');
        expect(await page.locator('#wp-lock').inputValue()).toBe('producer');
        await page.mouse.move(1400, 900);
        expect(await fixture.browser.names(page, 'g.node.wp-neighbor')).not.toContain('unrelated');
        await page.locator('#wp-filter-toggle').click();
        await page.locator('#wp-lock-toggle').click();
        expect(await page.locator('#wp-filter-toggle').getAttribute('aria-pressed')).toBe('true');
        expect(await page.locator('#wp-lock-toggle').getAttribute('aria-pressed')).toBe('false');
        await page.locator('#wp-lock-toggle').click();
        expect(await page.locator('#wp-lock-toggle').getAttribute('aria-pressed')).toBe('true');
        await fixture.browser.snapshot(page, '1185-runtime-shell');
        await fixture.panels(page, '1185-runtime');
        await page.close();
        const architecture = await fixture.browser.open(
            '1185-architecture-shell',
            fixture.browser.architecture(FilterFixture.wide()),
        );
        await fixture.browser.lock(architecture, 'pr-gate');
        await architecture.locator('#wp-lock-toggle').click();
        expect(await architecture.locator('#wp-lock-toggle').getAttribute('aria-pressed')).toBe(
            'false',
        );
        await fixture.browser.snapshot(architecture, '1185-architecture-shell');
        await fixture.panels(architecture, '1185-architecture');
        await architecture.close();
    });

    it('stages and cancels facets, counts services, recovers zero matches, and keeps contextual shapes', async () => {
        const page = await fixture.browser.open('1185-runtime-filter', fixture.html());
        const full = await fixture.browser.names(page);
        await page.locator('#wp-filter-open').click();
        await page.locator('[data-wp-chip-group="runtime"][data-wp-chip="browser"]').click();
        expect(await page.locator('#wp-filter-apply').textContent()).toBe('Show 1 service');
        expect(await fixture.browser.names(page)).toEqual(full);
        await page.locator('#wp-filter-close').click();
        await page.locator('#wp-filter-open').click();
        expect(await page.locator('[data-wp-chip="browser"]').getAttribute('aria-pressed')).toBe(
            'false',
        );
        await page.locator('[data-wp-chip="browser"]').click();
        await page.locator('[data-wp-chip-group="role"][data-wp-chip="server"]').click();
        expect(await page.locator('#wp-filter-apply').textContent()).toBe('Show 0 services');
        await page.locator('#wp-filter-apply').click();
        expect(await page.locator('#wp-empty').isVisible()).toBe(true);
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-filter-clear').click();
        await page.locator('#wp-filter-apply').click();
        await page.locator('#wp-filter-open').click();
        await page.locator('[data-wp-chip-group="product"][data-wp-chip="shop"]').click();
        await fixture.browser.snapshot(page, '1185-runtime-filter');
        await page.locator('#wp-filter-apply').click();
        expect(await fixture.browser.names(page)).not.toContain('unrelated');
        expect(await page.locator('#wp-context-count').textContent()).toBe(
            '2 services · 4 contextual nodes',
        );
        expect(
            await fixture.browser.node(page, 'queue__TaskApi_send').locator('path').count(),
        ).toBe(2);
        await page.locator('#wp-filter-pills button').click();
        expect(await fixture.browser.names(page)).toEqual(full);
        await page.close();
    });

    it('opens Implements only from the node menu, Uses only from edges, and preserves provenance after recoloring', async () => {
        const page = await fixture.browser.open('1185-runtime-details', fixture.html());
        const summary = fixture.browser
            .node(page, 'consumer')
            .locator('text')
            .filter({ hasText: 'Implements' });
        await summary.hover();
        expect(await page.locator('.wp-graph-details').isVisible()).toBe(false);
        expect(await page.locator('g.node .wp-api-detail').count()).toBe(0);
        expect(
            (await page.locator('g.node text').allTextContents()).some((text) =>
                text.startsWith('Uses'),
            ),
        ).toBe(false);
        await summary.click();
        await page
            .locator('#wp-node-menu')
            .getByRole('button', { name: 'Implements', exact: true })
            .click();
        expect(await page.locator('.wp-graph-details').textContent()).toContain(
            'task-contracts#TaskApi',
        );
        expect(await page.locator('.wp-graph-details').textContent()).toContain('TASKS_ENABLED');
        await page.keyboard.press('Escape');
        expect(await page.locator('.wp-graph-details').isVisible()).toBe(false);
        const edge = page
            .locator('g.edge')
            .filter({ has: page.locator('title', { hasText: /^producer->queue__TaskApi_send$/ }) })
            .locator('text')
            .first();
        await edge.hover();
        await edge.focus();
        expect(await page.locator('.wp-graph-details').isVisible()).toBe(false);
        await edge.press('Enter');
        expect(await page.locator('.wp-graph-details').textContent()).toContain('shared-client');
        expect(await page.locator('.wp-graph-details').textContent()).toContain('methods inferred');
        expect(await page.locator('#wp-node-menu').count()).toBe(0);
        await fixture.browser.mode(page, 'architecture');
        // Clicking outside explicitly dismisses before the mode redraw; new SVG controls rebind.
        await page.locator('g.edge .wp-api-detail').first().click();
        expect(await page.locator('.wp-graph-details').isVisible()).toBe(true);
        await fixture.browser.snapshot(page, '1185-runtime-details');
        await page.locator('.wp-graph-details button').click();
        expect(await page.locator('.wp-graph-details').isVisible()).toBe(false);
        await page.close();
    });

    it('projects Nx Impact onto services without attributing changed libraries or CI to vendors', async () => {
        const scan = impactScan(
            ImpactKind.BRANCH,
            BRANCH_LABEL,
            ['shared-client'],
            ['producer', 'consumer'],
            ['unrelated'],
            1,
            [],
        );
        const page = await fixture.browser.openWithImpact(
            '1185-runtime-impact',
            fixture.html(),
            new ImpactSidecarData([scan], ImpactKind.BRANCH),
        );
        await fixture.browser.mode(page, 'impact');
        expect(
            await fixture.browser
                .node(page, 'producer')
                .locator('polygon')
                .first()
                .getAttribute('fill'),
        ).toBe('#fde3b0');
        expect(
            await fixture.browser
                .node(page, 'system__db')
                .locator('path')
                .first()
                .getAttribute('fill'),
        ).not.toBe('#f5a524');
        await page.locator('#wp-filter-open').click();
        await page.locator('input[value="changed"]').check();
        expect(await page.locator('#wp-filter-apply').textContent()).toBe('Show 0 services');
        await page.locator('input[value="dependents"]').check();
        expect(await page.locator('#wp-filter-apply').textContent()).toBe('Show 2 services');
        await page.locator('#wp-filter-apply').click();
        expect(await fixture.browser.names(page)).not.toContain('unrelated');
        await fixture.browser.snapshot(page, '1185-runtime-impact');
        await page.close();
    });

    it('supports narrow layouts, drawer collapse, shortcuts and separate remembered modes', async () => {
        const page = await fixture.browser.open('1185-runtime-narrow', fixture.html());
        await page.evaluate(() => {
            localStorage.setItem('wp-architecture-graph-mode', 'architecture');
            localStorage.setItem('wp-runtime-graph-mode', 'product');
        });
        await page.reload();
        await page.locator('g.wp-node-clickable').first().waitFor();
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Product');
        await page.setViewportSize({ width: 700, height: 700 });
        await page.locator('#wp-collapse').click();
        expect(await page.locator('#wp-side').isVisible()).toBe(false);
        await page.keyboard.press('/');
        // Expanding restores access to Focus in a narrow window.
        await page.keyboard.press('/');
        expect(await page.locator('#wp-lock').evaluate((el) => el === document.activeElement)).toBe(
            true,
        );
        await page.locator('#wp-help-btn').click();
        expect(await page.locator('#wp-help').isVisible()).toBe(true);
        await page.screenshot({
            path: path.join(fixture.browser.output, '1185-runtime-narrow.png'),
        });
        await page.close();
    });

    it('renders a representative large saved runtime graph and records responsiveness', async () => {
        const root = '/Users/deanhiller/workspace/ctoteachings/monorepo1/architecture';
        const graph = fs.existsSync(path.join(root, 'runtime-dependencies.json'))
            ? (JSON.parse(
                  fs.readFileSync(path.join(root, 'runtime-dependencies.json'), 'utf8'),
              ) as RuntimeGraph)
            : fixture.graph;
        const projects = fs.existsSync(path.join(root, 'dependencies.json'))
            ? (
                  JSON.parse(fs.readFileSync(path.join(root, 'dependencies.json'), 'utf8')) as {
                      projects: EnhancedGraph;
                  }
              ).projects
            : fixture.projects;
        fixture.addLoad(graph, projects);
        const started = Date.now();
        const page = await fixture.browser.open(
            '1185-runtime-large',
            fixture.html(graph, projects),
        );
        const rendered = Date.now() - started;
        const filtering = Date.now();
        await page.locator('#wp-filter-open').click();
        await page.locator('#wp-filter-apply').click();
        const elapsed = Date.now() - filtering;
        fs.writeFileSync(
            path.join(fixture.browser.output, '1185-metrics.json'),
            JSON.stringify({
                services: Object.keys(graph.services).length,
                renderMs: rendered,
                filterMs: elapsed,
            }),
        );
        console.log(
            `1185 large graph: ${Object.keys(graph.services).length} saved services; first render ${rendered}ms; filter apply ${elapsed}ms`,
        );
        await page.getByRole('button', { name: 'Fit overview', exact: true }).click();
        await fixture.browser.snapshot(page, '1185-runtime-large');
        await page.close();
    });
});
