import { describe, it, expect } from 'vitest';
import { FinishBanner, FinishBannerInput } from './finish-banner';
import {
    MergeOutcome, MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND, MERGE_RESULT_FAILED,
} from './pr-merger';

const banner = new FinishBanner();

const render = (outcome: MergeOutcome): string =>
    banner.render(new FinishBannerInput('511', 'https://github.com/o/r/pull/511', 'My PR title', 'dean/feature', outcome));

const directive = (outcome: MergeOutcome): string =>
    banner.linkDirective(new FinishBannerInput('511', 'https://github.com/o/r/pull/511', 'My PR title', 'dean/feature', outcome));

const MERGED = new MergeOutcome(true, false, 'squash-merged the PR as: "My PR title (#511)"', MERGE_RESULT_MERGED);
const QUEUED = new MergeOutcome(false, true, 'enabled auto-merge — it will squash-merge when the checks pass', MERGE_RESULT_AUTO_QUEUED);
const HUMAN = new MergeOutcome(false, false, 'did NOT merge — pr-gate.mergeMode is NONE', MERGE_RESULT_LEFT_TO_HUMAN);
const BEHIND = new MergeOutcome(false, true, '⛔ did NOT merge — the head branch is BEHIND its base (mergeStateStatus=BEHIND)', MERGE_RESULT_BEHIND);
const FAILED = new MergeOutcome(false, false, '⚠️  did NOT merge and could NOT enable auto-merge either', MERGE_RESULT_FAILED);

describe('a merged PR', () => {
    it('prints success and asks for nothing further', () => {
        const out = render(MERGED);
        expect(out).toContain('✅');
        expect(out).toContain('MERGED');
        expect(out).not.toContain('DO NOT WALK AWAY');
        expect(out).not.toContain('wp-start-upsert-pr');
    });
});

describe('auto-merge enabled (the BLOCKED-on-checks case)', () => {
    it('reads as success, and says explicitly that stopping here is correct', () => {
        const out = render(QUEUED);
        expect(out).toContain('✅ PR finished');
        expect(out).toContain('lands itself when the checks pass');
        expect(out).toContain('You can stop here');
        expect(out).not.toContain('NOT FINISHED');
    });
});

describe('mergeMode NONE — a human merges', () => {
    it('reads as success: the tooling owed only the PR', () => {
        const out = render(HUMAN);
        expect(out).toContain('✅ PR finished');
        expect(out).not.toContain('NOT FINISHED');
    });
});

describe('BEHIND — the outcome that used to print a green checkmark', () => {
    it('does NOT print "✅ PR finished"', () => {
        const out = render(BEHIND);
        expect(out).not.toContain('✅');
        expect(out).toContain('⛔ PR NOT FINISHED');
        expect(out).toContain('BEHIND');
    });

    it('prints the exact re-run remedy, in order, so an agent recovers without a human', () => {
        const out = render(BEHIND);
        expect(out).toContain('pnpm wp-start-upsert-pr');
        expect(out).toContain('pnpm wp-finish-upsert-pr');
        expect(out.indexOf('pnpm wp-start-upsert-pr')).toBeLessThan(out.indexOf('pnpm wp-finish-upsert-pr'));
        expect(out).toContain('DO NOT WALK AWAY');
        expect(out).toContain('gh pr view 511 --json mergeable,mergeStateStatus,state');
    });

    it('still relays PrMerger\'s own message verbatim', () => {
        expect(render(BEHIND)).toContain(BEHIND.message);
    });

    it('cannot end on a link that implies completion — the link text carries the truth', () => {
        const out = directive(BEHIND);
        expect(out).toContain('this PR is NOT done');
        expect(out).toContain('[#511 My PR title — NOT MERGED — BEHIND main, needs a re-sync](https://github.com/o/r/pull/511)');
    });
});

describe('a generic merge failure', () => {
    it('reads as not-done and names the re-run', () => {
        const out = render(FAILED);
        expect(out).not.toContain('✅');
        expect(out).toContain('⚠️  PR NOT FINISHED');
        expect(out).toContain('DO NOT report this PR as done');
        expect(out).toContain('pnpm wp-finish-upsert-pr');
    });

    it('marks the closing link NOT MERGED', () => {
        expect(directive(FAILED)).toContain('[#511 My PR title — NOT MERGED](https://github.com/o/r/pull/511)');
    });
});

describe('the closing link directive on a healthy run', () => {
    it('is unchanged: the bare clickable link, nothing after it', () => {
        const out = directive(MERGED);
        expect(out).toContain('[#511 My PR title](https://github.com/o/r/pull/511)');
        expect(out).not.toContain('NOT done');
    });

    it('is omitted entirely when the PR could not be resolved', () => {
        expect(banner.linkDirective(new FinishBannerInput('', '', 'My PR title', 'dean/feature', FAILED))).toBe('');
    });
});
