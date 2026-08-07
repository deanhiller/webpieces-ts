import { describe, expect, it } from 'vitest';
import { ReviewJson } from '@webpieces/rules-config';
import { Dashboard, DashboardInput } from './dashboard';

const dash = new Dashboard();
const URL = 'https://github.com/o/r/pull/42';

function input(reviewOverrides: Partial<ReviewJson> = {}): DashboardInput {
    const review = Object.assign(
        new ReviewJson('A short title', 20, 'green', '🟢', 'S1. S2. S3. S4. S5.', [], [], []),
        reviewOverrides,
    );
    return new DashboardInput(
        'My PR',
        dash.computeGateResults([], []),
        dash.countAddedDisables(''),
        true,
        'aaaaaaaaaaaa',
        'bbbbbbbbbbbb',
        'cccccccccccc',
        review,
        [],
        'pnpm nx affected --target=ci',
    );
}

/**
 * THE invariant this whole surface swap rests on: **the PR description and the squash-merge commit body
 * are one string.**
 *
 * Four routes can land a PR, and before this they did not agree. `wp-land-pr` and finish's own auto-merge
 * pass an explicit `--body-file`; the GitHub Merge button and a bare `gh pr merge` instead copy the PR
 * DESCRIPTION, via the repo's `squash_merge_commit_message: PR_BODY`. While the description held the long
 * dashboard and `--body-file` held a compact summary, *which route landed the commit decided what main's
 * history said* — and the two repos that merge through the UI accumulated the entire risk table, hash
 * points and gate token in every single squash commit.
 *
 * Making them the same string is what removes the discrepancy, and it removes it WITHOUT requiring anyone
 * to remember a command OR to configure anything: it rests on two GitHub repo settings
 * (`squash_merge_commit_title: PR_TITLE` + `squash_merge_commit_message: PR_BODY`) that
 * SquashSettingsEnforcer pins on every stage ③ run, so the default path is simply correct.
 *
 * So this file exists to fail the moment the two renderings drift apart again. It is deliberately a
 * separate spec rather than one more case in dashboard.spec.ts: this is not a property of the renderer,
 * it is the contract BETWEEN two surfaces, and it should be the thing that goes red — by name — if a
 * later change reintroduces a "commit body" renderer.
 */
describe('the PR description IS the squash-merge commit body', () => {
    /**
     * There is exactly ONE renderer for both. If a second appears, this stops compiling — which is the
     * point: the failure mode being guarded is someone re-adding a separate commit-body renderer, and a
     * string comparison between two functions cannot catch a function that does not exist yet.
     */
    it('is produced by a single renderer, so the two can never be rendered differently', () => {
        expect(typeof dash.renderPrBody).toBe('function');
        // The pre-swap names are GONE, not deprecated — per the repo's no-backwards-compatibility rule a
        // surface has one spelling. `renderCommitBody` in particular must not come back: its existence
        // WAS the drift.
        expect((dash as unknown as Record<string, unknown>).renderCommitBody).toBeUndefined();
        expect((dash as unknown as Record<string, unknown>).renderDashboard).toBeUndefined();
    });

    /** Same inputs ⇒ same bytes, every time. Both consumers call it with the resolved PR url. */
    it('renders byte-identical output for the PR body and the merge body', () => {
        const shared = input();
        expect(dash.renderPrBody(shared, URL)).toBe(dash.renderPrBody(shared, URL));
    });

    /**
     * A UI merge copies the description as-is, so anything unfit for `git log` must not be in it. The long
     * dashboard is checked in dashboard.spec.ts; what is checked here is the SHAPE: no markdown heading,
     * no table, and nothing hidden except the gate token the caller appends after this string.
     */
    it('contains nothing a plain-text git log cannot carry', () => {
        const body = dash.renderPrBody(input(), URL);
        expect(body).not.toContain('##');
        expect(body).not.toContain('|');
        expect(body).not.toContain('<sub>');
        expect(body).not.toContain('<!--');
    });

    /**
     * The self-link survives the round trip. In `git log` this is the ONLY way back to the PR — the
     * dashboard, the reviewer output and the full summary are all in comments this text cannot reach.
     */
    it('leads with the PR link, which is the only navigation a squash commit has', () => {
        expect(dash.renderPrBody(input(), URL).startsWith(`${URL} (for git log)`)).toBe(true);
    });
});
