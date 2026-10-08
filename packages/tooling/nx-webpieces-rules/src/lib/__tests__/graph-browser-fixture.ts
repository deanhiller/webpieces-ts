/**
 * The real-browser fixture shared by the opt-in Viz suites (graph-filter-browser.spec.ts and
 * graph-impact-browser.spec.ts): launches headless chromium, serves Viz from WP_GRAPH_VIZ_JS, and
 * opens generated pages straight from disk, optionally beside an Impact sidecar.
 */
import { randomUUID } from 'crypto';
import { expect } from 'vitest';
import { chromium, type Browser, type Page, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { FilterFixture } from './graph-filter-fixture';
import { ResponsibilitiesRenderer } from '../graph-responsibilities';
import type { EnhancedGraph } from '../graph-sorter';
import type { GraphRenderModel, RenderEdge } from '../graph-render-model';
import { ImpactKind, ImpactReport, ImpactSidecar, ImpactSidecarData } from '../graph-impact';

export const BRANCH_LABEL = 'Changed on this branch (since abc1234)';
export const COMMIT_LABEL = 'Changed since def5678 — Upgrade the thing (#1162)';

/** One available scan, as the scanner builds it. */
export function impactScan(
    kind: ImpactKind,
    label: string,
    touched: string[],
    affected: string[],
    buildInputs: string[],
    changedFiles: number,
    dependencies: string[],
    globalFiles: string[] = [],
    reason = '',
): ImpactReport {
    const dirty = label.endsWith('+ uncommitted changes');
    return new ImpactReport(kind, label, dirty, true, reason, 'abc1234', touched, affected, buildInputs, changedFiles, dependencies, globalFiles);
}

/** Opt-in browser suite: WP_GRAPH_VIZ_JS supplies Viz 3; the cross-page test additionally uses
 * WP_GRAPH_VIZ2_JS and WP_GRAPH_VIZ2_RENDER_JS for design's pinned Viz 2.1.2 scripts. */
export class BrowserFixture {
    constructor(readonly output: string = path.resolve('.webpieces/1118-browser-evidence', randomUUID())) {}
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

    /** Lock through the drawer's type-to-search field ('' unlocks), exactly as a viewer types it. */
    async lock(page: Page, id: string): Promise<void> {
        await page.locator('#wp-lock').fill(id);
    }

    /**
     * Open a page with an Impact sidecar beside it. The sidecar directory is shared by every page this
     * suite writes, so it goes as soon as this page has loaded it.
     */
    async openWithImpact(name: string, html: string, data: ImpactSidecarData): Promise<Page> {
        const sidecarDir = path.join(this.output, '.impact');
        fs.mkdirSync(sidecarDir, { recursive: true });
        // The real writer's script, so the page reads exactly the shape generate/visualize write.
        fs.writeFileSync(path.join(sidecarDir, 'dependencies.impact.js'), new ImpactSidecar().script(data));
        const page = await this.open(name, html);
        fs.rmSync(sidecarDir, { recursive: true, force: true });
        return page;
    }

    /** Pick a mode through the drawer's Color-by pulldown, exactly as a viewer does. */
    async mode(page: Page, mode: string): Promise<void> {
        await page.locator('#wp-mode-trigger').click();
        await page.locator(`#wp-mode-menu .wp-mode[data-wp-mode="${mode}"]`).click();
    }

    /** Real boxes only: a level emptied by filtering is a labeled `wp-layout` band, not a project. */
    async names(page: Page, selector = '#graph g.node:not(.wp-layout)'): Promise<string[]> {
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
