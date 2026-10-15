/**
 * #1264 in a real browser: WHY each affected box is in the build, and the edges this branch gained
 * and lost since its fork point. Opt-in like graph-impact-browser.spec.ts: WP_GRAPH_VIZ_JS supplies
 * Viz 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { BRANCH_LABEL, BrowserFixture, NO_EDGES, WIRING_INPUT, impactScan } from './graph-browser-fixture';
import type { EnhancedGraph } from '../graph-sorter';
import { ImpactKind, ImpactSidecarData } from '../graph-impact';
import { EdgeChange, EdgeChangeKind, EdgeDiffReport, EdgeRelation } from '../graph-edge-diff';

const fixture = new BrowserFixture();

/** The SAVED page: svc-a depends on lib-b. On the branch, svc-a uses lib-c instead. */
const GRAPH: EnhancedGraph = {
    'svc-a': { level: 2, dependsOn: ['lib-b'], role: 'server' },
    'public-api': { level: 2, dependsOn: [], role: 'server' },
    'lib-b': { level: 0, dependsOn: [], role: 'lib' },
    'lib-c': { level: 0, dependsOn: [], role: 'lib' },
};

const LOST = new EdgeChange('svc-a', 'lib-b', EdgeChangeKind.LOST, EdgeRelation.DEPENDS, [], 'svc-a no longer depends on lib-b');
const GAINED = new EdgeChange('svc-a', 'lib-c', EdgeChangeKind.GAINED, EdgeRelation.DEPENDS, [], 'new on this branch: svc-a now depends on lib-c');

function edge(page: Page, title: string): ReturnType<Page['locator']> {
    return page.locator('#graph g.edge', { has: page.locator('title', { hasText: new RegExp(`^${title}$`) }) });
}

describe.skipIf(!process.env['WP_GRAPH_VIZ_JS'])('Impact reasons and edge changes in a real browser (#1264)', () => {
    beforeAll(() => fixture.start());
    afterAll(async () => fixture.browser?.close());

    it('draws a gained and a lost edge in red, and the lost one is clickable', async () => {
        const edges = new EdgeDiffReport('abc1234', '', [LOST, GAINED], '', []);
        const scan = impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['svc-a'], [], [], 1, []);
        const page = await fixture.openWithImpact('1264-edges', fixture.architecture(GRAPH), new ImpactSidecarData([scan], ImpactKind.BRANCH, edges));
        await fixture.mode(page, 'impact');

        // The saved page draws the lost edge: restyled as a red dashed ghost.
        const lost = edge(page, 'svc-a->lib-b');
        await expect.poll(() => lost.locator('path').first().getAttribute('stroke')).toBe('#d32f2f');
        expect(await lost.locator('path').first().getAttribute('stroke-dasharray')).not.toBeNull();
        // The saved page lacks the gained edge: it is drawn over it, solid red.
        const gained = edge(page, 'svc-a->lib-c');
        expect(await gained.count()).toBe(1);
        expect(await gained.locator('path').first().getAttribute('stroke')).toBe('#d32f2f');
        expect(await gained.locator('path').first().getAttribute('stroke-dasharray')).toBeNull();

        // Clicking the lost edge says what was lost.
        await lost.dispatchEvent('click');
        const panel = page.locator('.wp-impact-why');
        expect(await panel.isVisible()).toBe(true);
        expect(await panel.locator('strong').textContent()).toBe('Lost edge');
        expect(await panel.locator('li').allTextContents()).toEqual(['svc-a no longer depends on lib-b']);
        await gained.dispatchEvent('click');
        expect(await panel.locator('li').allTextContents()).toEqual(['new on this branch: svc-a now depends on lib-c']);

        // lib-b and lib-c changed only by an edge: each gets the badge; svc-a (changed) does not.
        expect(await fixture.node(page, 'lib-b').locator('.wp-edge-badge').count()).toBe(1);
        expect(await fixture.node(page, 'lib-c').locator('.wp-edge-badge').count()).toBe(1);
        expect(await fixture.node(page, 'svc-a').locator('.wp-edge-badge').count()).toBe(0);
        expect(await page.locator('#wp-side [data-wp-impact-note]').textContent()).toContain('Edges since abc1234: 1 gained · 1 lost.');

        // "Edge changes only" keeps exactly the boxes at either end of a changed edge.
        await page.locator('#wp-filter-open').click();
        await page.locator('input[name="wp-scope"][value="edges"]').check();
        await page.locator('#wp-filter-apply').click();
        await expect.poll(() => fixture.names(page)).toEqual(['lib-b', 'lib-c', 'svc-a']);
        await page.screenshot({ path: path.join(fixture.output, '1264-edges.png') });
        await page.close();
    });

    it('says so when the fork point has no graph, and draws no edge change', async () => {
        const edges = EdgeDiffReport.unavailable('No architecture graph at the fork point abc1234 (first adoption), so there is nothing to compare edges against', 'abc1234');
        const scan = impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['svc-a'], [], [], 1, []);
        const page = await fixture.openWithImpact('1264-no-base', fixture.architecture(GRAPH), new ImpactSidecarData([scan], ImpactKind.BRANCH, edges));
        await fixture.mode(page, 'impact');
        expect(await page.locator('#wp-side [data-wp-impact-note]').textContent()).toContain('(first adoption)');
        expect(await page.locator('#graph g.edge.wp-edge-change').count()).toBe(0);
        await page.close();
    });

    it('opens WHY an implicitly touched box is in the build from its menu', async () => {
        const scan = impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['svc-a'], [], [], 1, [], [], '', ['public-api']);
        const page = await fixture.openWithImpact('1264-why', fixture.architecture(GRAPH), new ImpactSidecarData([scan], ImpactKind.BRANCH, NO_EDGES));
        await fixture.mode(page, 'impact');
        await fixture.node(page, 'public-api').locator('text').first().click();
        await page.locator('#wp-node-menu').getByRole('button', { name: 'Why in this build? (implicitly touched)' }).click();
        const panel = page.locator('.wp-impact-why');
        expect(await panel.locator('strong').textContent()).toBe('Implicitly touched: public-api');
        expect(await panel.locator('li').first().textContent()).toBe(`wiring-check input ${WIRING_INPUT} matched services/a/src/wiring.ts`);
        await page.close();
    });
});
