/**
 * Impact's two comparisons in a real browser (#1163): "Changed on this branch" and "Last commit".
 * Opt-in like graph-filter-browser.spec.ts: WP_GRAPH_VIZ_JS supplies Viz 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { FilterFixture } from './graph-filter-fixture';
import { BRANCH_LABEL, BrowserFixture, COMMIT_LABEL, impactScan } from './graph-browser-fixture';
import type { EnhancedGraph } from '../graph-sorter';
import { ImpactKind, ImpactReport, ImpactSidecarData, NOTHING_CHANGED_ON_BRANCH, ROOT_COMMIT_REASON } from '../graph-impact';

const fixture = new BrowserFixture();

describe.skipIf(!process.env.WP_GRAPH_VIZ_JS)('Impact comparisons in a real browser', () => {
    beforeAll(() => fixture.start());
    afterAll(async () => fixture.browser?.close());

    it('toggles between "Changed on this branch" and "Last commit": recolours, re-filters, relabels, remembers', async () => {
        const graph: EnhancedGraph = {
            'portal-web': { level: 3, dependsOn: ['ui-kit'], role: 'client' },
            'jobs-svr': { level: 3, dependsOn: ['server-auth'], role: 'server' },
            'ui-kit': { level: 2, dependsOn: ['model'], role: 'lib' },
            'server-auth': { level: 2, dependsOn: ['model'], role: 'lib' },
            model: { level: 0, dependsOn: [], role: 'lib' },
        };
        const dirtyCommit = `${COMMIT_LABEL} + uncommitted changes`;
        const page = await fixture.openWithImpact(
            '1163-toggle',
            fixture.architecture(graph),
            new ImpactSidecarData(
                [
                    impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['ui-kit'], ['portal-web'], ['model'], 1, ['model']),
                    impactScan(ImpactKind.COMMIT, dirtyCommit, ['server-auth'], ['jobs-svr'], ['model'], 3, ['model']),
                ],
                ImpactKind.BRANCH,
            ),
        );
        const drawerToggle = page.locator('#wp-side [data-wp-impact-kinds="drawer"]');
        // The drawer's copy belongs to Impact mode.
        expect(await drawerToggle.isVisible()).toBe(false);
        await fixture.mode(page, 'impact');
        expect(await drawerToggle.isVisible()).toBe(true);
        const pressed = (where: string, kind: string): Promise<string | null> =>
            page.locator(`[data-wp-impact-kinds="${where}"] [data-wp-impact-kind="${kind}"]`).getAttribute('aria-pressed');
        expect([await pressed('drawer', 'branch'), await pressed('drawer', 'commit')]).toEqual(['true', 'false']);
        const fill = (id: string): Promise<string | null> => fixture.node(page, id).locator('polygon').first().getAttribute('fill');
        await expect.poll(() => fill('ui-kit')).toBe('#f5a524');
        expect(await fill('server-auth')).toBe('#eef0f4');
        const note = (): Promise<string | null> => page.locator('#wp-side [data-wp-impact-note]').textContent();
        expect(await note()).toContain(`${BRANCH_LABEL}: 1 changed · 1 dependents · 1 dependencies`);

        // The Filter popover's change group is headed by the ACTIVE label and carries the toggle too.
        await page.locator('#wp-filter-open').click();
        expect(await page.locator('#wp-scope-legend').textContent()).toBe(BRANCH_LABEL);
        expect(await page.locator('#wp-filter-pop [data-wp-impact-kinds="filter"]').isVisible()).toBe(true);
        await page.locator('input[name="wp-scope"][value="changed"]').check();
        await page.locator('#wp-filter-apply').click();
        expect(await fixture.names(page)).toEqual(['ui-kit']);

        // Switching recolours Impact and re-applies the active "Changed" filter against the other scan.
        await drawerToggle.locator('[data-wp-impact-kind="commit"]').click();
        await expect.poll(() => fixture.names(page)).toEqual(['server-auth']);
        await expect.poll(() => fill('server-auth')).toBe('#f5a524');
        expect([await pressed('drawer', 'branch'), await pressed('drawer', 'commit')]).toEqual(['false', 'true']);
        expect(await note()).toContain(`${dirtyCommit}: 1 changed · 1 dependents · 1 dependencies`);
        expect(await page.evaluate(() => localStorage.getItem('wp-architecture-graph-impact-kind'))).toBe('commit');

        // The popover's own toggle switches back, and its heading and counts follow.
        await page.locator('#wp-filter-open').click();
        expect(await page.locator('#wp-scope-legend').textContent()).toBe(dirtyCommit);
        await page.locator('#wp-filter-pop [data-wp-impact-kind="branch"]').click();
        expect(await page.locator('#wp-scope-legend').textContent()).toBe(BRANCH_LABEL);
        expect(await page.locator('[data-wp-scope-count="dependents"]').textContent()).toBe('2');
        expect(await pressed('filter', 'branch')).toBe('true');
        await page.locator('#wp-filter-close').click();
        await expect.poll(() => fixture.names(page)).toEqual(['ui-kit']);
        await page.screenshot({ path: path.join(fixture.output, '1163-toggle.png') });
        await page.close();
    });

    it('shows a fresh branch as "Nothing changed on this branch yet", with no toggle', async () => {
        const page = await fixture.openWithImpact(
            '1163-fresh',
            fixture.architecture(FilterFixture.wide()),
            new ImpactSidecarData(
                [impactScan(ImpactKind.BRANCH, BRANCH_LABEL, [], [], [], 0, [], [], NOTHING_CHANGED_ON_BRANCH)],
                ImpactKind.BRANCH,
            ),
        );
        await fixture.mode(page, 'impact');
        expect(await page.locator('#wp-mode-current').textContent()).toBe('Impact');
        expect(await page.locator('#wp-side [data-wp-impact-note]').textContent()).toBe(
            `${BRANCH_LABEL}: ${NOTHING_CHANGED_ON_BRANCH}.`,
        );
        expect(await page.locator('[data-wp-impact-kinds]:visible').count()).toBe(0);
        await page.locator('#wp-filter-open').click();
        expect(await page.locator('[data-wp-scope-count="changed"]').textContent()).toBe('0');
        await page.close();
    });

    it('labels an unavailable scan in the reason and keeps the toggle option disabled', async () => {
        const rootCommit = new ImpactReport(ImpactKind.COMMIT, 'Last commit', false, false, ROOT_COMMIT_REASON, '', [], [], [], 0, [], []);
        const page = await fixture.openWithImpact(
            '1163-unavailable',
            fixture.architecture(FilterFixture.wide()),
            new ImpactSidecarData(
                [impactScan(ImpactKind.BRANCH, BRANCH_LABEL, ['rules-config'], [], [], 1, []), rootCommit],
                ImpactKind.BRANCH,
            ),
        );
        await fixture.mode(page, 'impact');
        const commit = page.locator('#wp-side [data-wp-impact-kinds="drawer"] [data-wp-impact-kind="commit"]');
        expect(await commit.isDisabled()).toBe(true);
        expect(await commit.getAttribute('title')).toBe(ROOT_COMMIT_REASON);
        await page.close();
    });
});
