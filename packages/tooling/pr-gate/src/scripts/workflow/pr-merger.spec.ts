import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERGE_MODE_AUTO, MERGE_MODE_NONE } from '@webpieces/rules-config';
import {
    PrMerger, MergeIntent, MergeOutcome, GhResult, PrMergeState,
    MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND_CLEAN, MERGE_RESULT_BEHIND_CONFLICTING, MERGE_RESULT_BEHIND_UNKNOWN, MERGE_RESULT_FAILED,
} from './pr-merger';

// A PrMerger whose `gh` seams are ALL canned, so the decision logic is exercised with NO gh, no network
// and no repo. `statuses` is consumed one entry per non-quiet gh call (captured or inherited); quiet
// calls (--disable-auto) are recorded but always "succeed" — matching the real no-op-when-not-enabled
// behavior. `state` is what GitHub would answer for mergeable/mergeStateStatus/state.
class FakePrMerger extends PrMerger {
    calls: string[][] = [];
    private readonly statuses: number[];
    private readonly autoAllowed: boolean;
    private readonly state: PrMergeState;

    constructor(statuses: number[], autoAllowed: boolean, state: PrMergeState) {
        super();
        this.statuses = statuses;
        this.autoAllowed = autoAllowed;
        this.state = state;
    }

    protected override autoMergeAllowed(): boolean {
        return this.autoAllowed;
    }

    protected override prMergeState(): PrMergeState {
        return this.state;
    }

    protected override gh(args: string[], quiet: boolean = false): number {
        this.calls.push(args);
        if (quiet) return 0;
        return this.statuses.shift() ?? 0;
    }

    protected override ghCapture(args: string[]): GhResult {
        this.calls.push(args);
        const status = this.statuses.shift() ?? 0;
        return new GhResult(status, status === 0 ? '' : 'X Pull request #7 is not mergeable: the head branch is not up to date with the base branch.\n');
    }
}

// Whatever the merger prints while deciding — the "expected first failure" framing lives there.
let printed = '';
const spyStdout = (): void => {
    printed = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
        printed += String(chunk);
        return true;
    });
};

afterEach((): void => {
    vi.restoreAllMocks();
});

// A healthy PR GitHub is happy about — the default for tests that are not about BEHIND.
const CLEAN = new PrMergeState('MERGEABLE', 'CLEAN', 'OPEN');
const BEHIND = new PrMergeState('MERGEABLE', 'BEHIND', 'OPEN');
const BEHIND_CONFLICTING = new PrMergeState('CONFLICTING', 'BEHIND', 'OPEN');
// GitHub's ordinary reply in the seconds after a force-push — it computes mergeability asynchronously.
const BEHIND_UNKNOWN = new PrMergeState('UNKNOWN', 'BEHIND', 'OPEN');

const mergeIntent = (statuses: number[], autoAllowed: boolean, intent: MergeIntent, state: PrMergeState): [MergeOutcome, string[][]] => {
    spyStdout();
    const merger = new FakePrMerger(statuses, autoAllowed, state);
    const outcome = merger.merge('dean/feature', 'My PR title (#7)', '/tmp/body.md', intent);
    return [outcome, merger.calls];
};

// The POLICY-driven caller (wp-finish-upsert-pr): `mode` is the config value and nothing else.
const mergeState = (statuses: number[], autoAllowed: boolean, mode: string, state: PrMergeState): [MergeOutcome, string[][]] =>
    mergeIntent(statuses, autoAllowed, new MergeIntent(mode, false), state);

// The COMMANDED caller (wp-land-pr): the merge happens whatever `mode` says.
const land = (statuses: number[], autoAllowed: boolean, mode: string): [MergeOutcome, string[][]] =>
    mergeIntent(statuses, autoAllowed, new MergeIntent(mode, true), CLEAN);

const mergeIn = (statuses: number[], autoAllowed: boolean, mode: string): [MergeOutcome, string[][]] =>
    mergeState(statuses, autoAllowed, mode, CLEAN);

// AUTO — the mode where the tooling is allowed to land the PR.
const merge = (statuses: number[], autoAllowed: boolean): [MergeOutcome, string[][]] =>
    mergeIn(statuses, autoAllowed, MERGE_MODE_AUTO);

// Every gh invocation flattened to a string, for asserting which flags were (and were NOT) used.
const flat = (calls: string[][]): string[] => calls.map((c: string[]): string => c.join(' '));

describe('direct merge succeeds', () => {
    it('reports merged and never touches auto-merge — on an auto-merge repo', () => {
        const [outcome, calls] = merge([0], true);
        expect(outcome.merged).toBe(true);
        expect(outcome.result).toBe(MERGE_RESULT_MERGED);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('My PR title (#7)');
        expect(flat(calls)).toEqual(['pr merge dean/feature --squash --subject My PR title (#7) --body-file /tmp/body.md']);
    });

    it('reports merged on a repo with auto-merge DISABLED (the direct merge does not need it)', () => {
        const [outcome, calls] = merge([0], false);
        expect(outcome.merged).toBe(true);
        expect(calls).toHaveLength(1);
        expect(flat(calls)[0]).not.toContain('--auto');
    });
});

describe('direct merge fails and auto-merge IS allowed', () => {
    it('falls back to --auto with the SAME subject/body, disabling first so the body is re-stamped', () => {
        const [outcome, calls] = merge([1, 0], true);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(true);
        expect(outcome.result).toBe(MERGE_RESULT_AUTO_QUEUED);
        expect(outcome.message).toContain('auto-merge');
        expect(flat(calls)).toEqual([
            'pr merge dean/feature --squash --subject My PR title (#7) --body-file /tmp/body.md',
            'pr merge dean/feature --disable-auto',
            'pr merge dean/feature --auto --squash --subject My PR title (#7) --body-file /tmp/body.md',
        ]);
    });

    it('a FAILING --auto is reported as a failure, not swallowed (the original bug)', () => {
        const [outcome] = merge([1, 1], true);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('did NOT merge');
    });
});

describe('direct merge fails and auto-merge is NOT allowed', () => {
    it('does not fire a --auto that can only error, and says nothing was queued', () => {
        const [outcome, calls] = merge([1], false);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.result).toBe(MERGE_RESULT_FAILED);
        expect(outcome.message).toContain('did NOT merge');
        expect(outcome.message).toContain('allow_auto_merge');
        expect(calls).toHaveLength(1);
        expect(flat(calls).some((c: string): boolean => c.includes('--auto'))).toBe(false);
    });

    it('IS a config mismatch when the AUTO was read from config, and names both remedies', () => {
        const [outcome] = merge([1], false);
        expect(outcome.message).toContain('CONFIG MISMATCH');
        expect(outcome.message).toContain('pr-gate.mergeMode is AUTO');
    });

    // The wp-land-pr bug: `AUTO` used to be passed as a VERB ("merge it"), and the message then asserted
    // it as a config value — on a repo whose mergeMode is NONE, prescribing remedies already in place.
    it('is NOT a config mismatch when wp-land-pr commanded the merge on a NONE repo', () => {
        const [outcome, calls] = land([1], false, MERGE_MODE_NONE);
        expect(outcome.result).toBe(MERGE_RESULT_FAILED);
        expect(outcome.message).toContain('did NOT merge');
        expect(outcome.message).toContain('allow_auto_merge');
        // Nothing is misconfigured — so no mismatch claim, and no assertion about mergeMode's value.
        expect(outcome.message).not.toContain('CONFIG MISMATCH');
        expect(outcome.message).not.toContain('mergeMode');
        expect(outcome.message).toContain('wp-land-pr');
        expect(flat(calls).some((c: string): boolean => c.includes('--auto'))).toBe(false);
    });
});

describe('a COMMANDED merge — `wp-land-pr` means "merge it", not "config says AUTO"', () => {
    it('merges on a NONE repo, which is the whole point of the command', () => {
        const [outcome, calls] = land([0], false, MERGE_MODE_NONE);
        expect(outcome.merged).toBe(true);
        expect(outcome.result).toBe(MERGE_RESULT_MERGED);
        expect(flat(calls)).toEqual(['pr merge dean/feature --squash --subject My PR title (#7) --body-file /tmp/body.md']);
    });

    it('merges even when the config value is missing entirely', () => {
        expect(land([0], false, '')[0].merged).toBe(true);
    });
});

describe('the PR is BEHIND its base — the outcome that never self-heals', () => {
    it('is reported as BEHIND, not as a queued success, even when --auto is accepted', () => {
        const [outcome] = mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND);
        expect(outcome.merged).toBe(false);
        expect(outcome.isBehind()).toBe(true);
        expect(outcome.message).toContain('landed on main first');
        expect(outcome.message).toContain('does NOT self-heal');
        // Still queued: a repo that auto-updates branches can land it, and un-queuing helps nobody.
        expect(outcome.autoMergeEnabled).toBe(true);
    });

    it('is still BEHIND — not a generic failure — when the repo forbids auto-merge', () => {
        const [outcome] = mergeState([1], false, MERGE_MODE_AUTO, BEHIND);
        expect(outcome.isBehind()).toBe(true);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('Nothing is queued');
    });

    // The split that lets the banner stop describing a queue collision as a merge conflict. `mergeable`
    // was always fetched here; until now it was fetched and thrown away.
    it('classifies a clean collision, a real conflict and an uncomputed answer as THREE outcomes', () => {
        expect(mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND)[0].result).toBe(MERGE_RESULT_BEHIND_CLEAN);
        expect(mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND_CONFLICTING)[0].result).toBe(MERGE_RESULT_BEHIND_CONFLICTING);
        expect(mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND_UNKNOWN)[0].result).toBe(MERGE_RESULT_BEHIND_UNKNOWN);
    });

    it('never reads UNKNOWN as "no conflicts" — that would promise a clean re-run we cannot see', () => {
        const [outcome] = mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND_UNKNOWN);
        expect(outcome.result).not.toBe(MERGE_RESULT_BEHIND_CLEAN);
        expect(outcome.isBehind()).toBe(true);
    });

    it('carries GitHub\'s own verdict verbatim, so nobody has to pattern-match gh prose', () => {
        const [outcome] = mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND);
        expect(outcome.message).toContain('mergeStateStatus=BEHIND');
        expect(outcome.message).toContain('mergeable=MERGEABLE');
    });

    it('an unreadable gh answer is NEVER diagnosed as BEHIND — it falls through as normal', () => {
        const [outcome] = mergeState([1, 0], true, MERGE_MODE_AUTO, new PrMergeState('', '', ''));
        expect(outcome.result).toBe(MERGE_RESULT_AUTO_QUEUED);
    });
});

describe('the expected first-attempt failure is framed, not dumped raw', () => {
    it('captures gh\'s `X …` line and reprints it as context plus a retry announcement', () => {
        mergeState([1, 0], true, MERGE_MODE_AUTO, CLEAN);
        expect(printed).toContain('the direct squash-merge did not go through');
        expect(printed).toContain('retrying with --auto');
        // The reason is still shown — framed, never hidden.
        expect(printed).toContain('X Pull request #7 is not mergeable');
    });

    it('says nothing about a retry when the direct merge worked', () => {
        mergeState([0], true, MERGE_MODE_AUTO, CLEAN);
        expect(printed).not.toContain('retrying with --auto');
    });
});

describe('gh cannot be spawned at all', () => {
    it('a -1 status is a failure, never mistaken for the 0 that means success', () => {
        const [outcome] = merge([-1], false);
        expect(outcome.merged).toBe(false);
        expect(outcome.message).toContain('did NOT merge');
    });
});

describe('mergeMode NONE — "a human clicks merge" repos', () => {
    it('runs NO gh merge command at all, even when the PR is perfectly mergeable', () => {
        const [outcome, calls] = mergeIn([0], true, MERGE_MODE_NONE);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(calls).toEqual([]);
    });

    it('still reports the subject GitHub should use, so the human merge can be checked', () => {
        const [outcome] = mergeIn([0], true, MERGE_MODE_NONE);
        expect(outcome.result).toBe(MERGE_RESULT_LEFT_TO_HUMAN);
        expect(outcome.message).toContain('mergeMode is NONE');
        expect(outcome.message).toContain('My PR title (#7)');
    });

    /**
     * Names BOTH repo settings a UI merge reads, because on a mergeMode=NONE repo a UI merge is the
     * NORMAL path and it is now the correct one: the PR description is the compact git-log body, so
     * `squash_merge_commit_message: PR_BODY` copies exactly the right text.
     *
     * One release ago this same message said the opposite — "PR_BODY pastes the whole dashboard, use
     * wp-land-pr instead" — which was true only while the description held the long dashboard. Asserting
     * both setting names, not the advice, is what keeps this test honest across that inversion.
     */
    it('names both squash_merge_commit_* settings, as pinned rather than as homework', () => {
        const [outcome] = mergeIn([0], true, MERGE_MODE_NONE);
        expect(outcome.message).toContain('squash_merge_commit_title=PR_TITLE');
        expect(outcome.message).toContain('squash_merge_commit_message=PR_BODY');
        // Offered as the CLI alternative, never as a correction to clicking Merge.
        expect(outcome.message).toContain('pnpm wp-land-pr');
        expect(outcome.message).not.toContain('whole dashboard');
        // SquashSettingsEnforcer repairs both on every run, so this must not read as a chore for the
        // reader. "both must be set" was true for exactly one release; it is homework nobody owes now.
        expect(outcome.message).not.toContain('both must be');
        expect(outcome.message).toContain('Nothing to set up');
    });
});

describe('an unknown or missing mergeMode — the fail-safe', () => {
    it('does NOT merge, because an unreadable policy must never be read as permission to touch main', () => {
        const [outcome, calls] = mergeIn([0], true, '');
        expect(outcome.merged).toBe(false);
        expect(calls).toEqual([]);
        expect(outcome.message).toContain('did NOT merge');
    });
});
