import { describe, it, expect } from 'vitest';
import { FinishBanner, FinishBannerInput } from './finish-banner';
import {
    MergeOutcome, MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND_CLEAN, MERGE_RESULT_BEHIND_CONFLICTING, MERGE_RESULT_BEHIND_UNKNOWN,
    MERGE_RESULT_FAILED,
} from './pr-merger';

const banner = new FinishBanner();

const render = (outcome: MergeOutcome): string =>
    banner.render(new FinishBannerInput('511', 'https://github.com/o/r/pull/511', 'My PR title', 'dean/feature', outcome));

const directive = (outcome: MergeOutcome): string =>
    banner.linkDirective(new FinishBannerInput('511', 'https://github.com/o/r/pull/511', 'My PR title', 'dean/feature', outcome));

const MERGED = new MergeOutcome(true, false, 'squash-merged the PR as: "My PR title (#511)"', MERGE_RESULT_MERGED);
const QUEUED = new MergeOutcome(false, true, 'enabled auto-merge — it will squash-merge when the checks pass', MERGE_RESULT_AUTO_QUEUED);
const HUMAN = new MergeOutcome(false, false, 'did NOT merge — pr-gate.mergeMode is NONE', MERGE_RESULT_LEFT_TO_HUMAN);
const behindMsg = 'did NOT merge — someone else landed on main first (mergeStateStatus=BEHIND)';
const BEHIND = new MergeOutcome(false, true, behindMsg, MERGE_RESULT_BEHIND_CLEAN);
const CONFLICTING = new MergeOutcome(false, true, behindMsg, MERGE_RESULT_BEHIND_CONFLICTING);
const UNKNOWN_BEHIND = new MergeOutcome(false, true, behindMsg, MERGE_RESULT_BEHIND_UNKNOWN);
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

    /**
     * The banner's ONLY chance to say how the merge should happen. A UI click takes its commit body from
     * squash_merge_commit_message, so on a PR_BODY repo every squash commit on main carries the full
     * dashboard — two consumer repos ran that way for months because this banner said "you can stop
     * here" and named no alternative. It still says stop; it now also names `wp-land-pr`.
     */
    /**
     * On a NONE repo a UI merge is the POLICY, so the banner's job is to confirm it works and name the two
     * settings it depends on — not to steer the reader off it. One release ago this block did the
     * opposite, because the PR description was then the long dashboard; it is now the compact git-log
     * body, so PR_BODY copies the right thing.
     */
    it('confirms a UI merge is correct and names the two settings it needs', () => {
        const out = render(HUMAN);
        expect(out).toContain('squash_merge_commit_title=PR_TITLE');
        expect(out).toContain('squash_merge_commit_message=PR_BODY');
        expect(out).toContain('pnpm wp-land-pr'); // offered as the CLI alternative, not a correction
        expect(out).not.toContain('ENTIRE dashboard');
        // Still the "nothing is owed" shape — no STOP/DO-NOT-report escalation on a policy outcome.
        expect(out).toContain('You can stop here.');
        expect(out).not.toContain('DO NOT report this PR as done');
    });
});

describe('BEHIND — not done, but not the author\'s failure either', () => {
    it('never claims success, and never blames the author with "PR NOT FINISHED"', () => {
        for (const outcome of [BEHIND, CONFLICTING, UNKNOWN_BEHIND]) {
            const out = render(outcome);
            expect(out).not.toContain('✅');
            expect(out).not.toContain('PR NOT FINISHED');
            // What DID happen: everything this command owns succeeded.
            expect(out).toContain('PR IS UP AND GREEN');
            expect(out).toContain('someone');
        }
    });

    it('prints the FULL three-stage remedy — skipping ② is what published an ungated tree', () => {
        const out = render(BEHIND);
        expect(out).toContain('pnpm wp-start-upsert-pr');
        expect(out).toContain('pnpm wp-review-upsert-pr');
        expect(out).toContain('pnpm wp-finish-upsert-pr');
        expect(out.indexOf('wp-start-upsert-pr')).toBeLessThan(out.indexOf('wp-review-upsert-pr'));
        expect(out.indexOf('wp-review-upsert-pr')).toBeLessThan(out.indexOf('wp-finish-upsert-pr'));
        expect(out).toContain('Do NOT skip ②');
    });

    it('warns off `gh pr update-branch` — it rewrites the REMOTE, which stage ③ then force-pushes over', () => {
        const out = render(BEHIND);
        expect(out).toContain('gh pr update-branch');
        expect(out).toContain('force-pushes over');
    });

    it('ASKS rather than orders — an imperative list is what turned an agent into a loop', () => {
        const out = render(BEHIND);
        expect(out).toContain('STOP HERE AND ASK THE HUMAN');
        expect(out).toContain('May I start the wp-*-upsert-pr process over again?');
        expect(out).not.toContain('DO NOT WALK AWAY');
    });

    it('tells a clean queue collision apart from a real conflict — they are different situations', () => {
        expect(render(BEHIND)).toContain('There are NO conflicts');
        // ...and says the out-of-date state may not even block anything on this repo.
        expect(render(BEHIND)).toContain('REQUIRE\n   branches be up to date');

        expect(render(CONFLICTING)).toContain('CONFLICTS with yours');
        expect(render(CONFLICTING)).toContain('not something you did wrong');
    });

    it('refuses to diagnose UNKNOWN — GitHub computes mergeability asynchronously', () => {
        const out = render(UNKNOWN_BEHIND);
        expect(out).toContain('not\n   finished computing mergeability');
        expect(out).toContain('Re-check before doing anything');
        expect(out).not.toContain('There are NO conflicts');
        // ...and the ASK matches: proposing a full re-run for work we cannot yet show is needed is wrong.
        expect(out).toContain('Shall I re-check in a moment');
        expect(out).not.toContain('May I start the wp-*-upsert-pr process over again?');
    });

    it('still relays PrMerger\'s own message verbatim', () => {
        expect(render(BEHIND)).toContain(BEHIND.message);
    });

    it('carries the truth INSIDE the link, and orders the AI to end by asking', () => {
        const out = directive(BEHIND);
        expect(out).toContain('this PR is NOT done');
        expect(out).toContain('MUST END BY ASKING the human');
        expect(out).toContain('[#511 My PR title — NOT MERGED — main moved (no conflicts), needs your OK to re-sync](https://github.com/o/r/pull/511)');
        expect(directive(CONFLICTING)).toContain('main moved and it conflicts, needs your OK to re-sync');
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
