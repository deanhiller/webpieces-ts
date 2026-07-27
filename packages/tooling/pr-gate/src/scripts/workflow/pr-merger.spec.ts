import { describe, it, expect } from 'vitest';
import { MERGE_MODE_DETECT, MERGE_MODE_DIRECT, MERGE_MODE_NONE } from '@webpieces/rules-config';
import { PrMerger, MergeOutcome } from './pr-merger';

// A PrMerger whose two `gh` seams are canned, so the decision logic is exercised with NO gh, no network
// and no repo. `statuses` is consumed one entry per non-quiet gh call; quiet calls (--disable-auto) are
// recorded but always "succeed" — matching the real no-op-when-not-enabled behavior.
class FakePrMerger extends PrMerger {
    calls: string[][] = [];
    private readonly statuses: number[];
    private readonly autoAllowed: boolean;

    constructor(statuses: number[], autoAllowed: boolean) {
        super();
        this.statuses = statuses;
        this.autoAllowed = autoAllowed;
    }

    protected override autoMergeAllowed(): boolean {
        return this.autoAllowed;
    }

    protected override gh(args: string[], quiet: boolean = false): number {
        this.calls.push(args);
        if (quiet) return 0;
        return this.statuses.shift() ?? 0;
    }
}

const mergeIn = (statuses: number[], autoAllowed: boolean, mode: string): [MergeOutcome, string[][]] => {
    const merger = new FakePrMerger(statuses, autoAllowed);
    const outcome = merger.merge('dean/feature', 'My PR title (#7)', '/tmp/body.md', mode);
    return [outcome, merger.calls];
};

// The default mode, which is what every repo gets unless it sets pr-gate.mergeMode.
const merge = (statuses: number[], autoAllowed: boolean): [MergeOutcome, string[][]] =>
    mergeIn(statuses, autoAllowed, MERGE_MODE_DETECT);

// Every gh invocation flattened to a string, for asserting which flags were (and were NOT) used.
const flat = (calls: string[][]): string[] => calls.map((c: string[]): string => c.join(' '));

describe('direct merge succeeds', () => {
    it('reports merged and never touches auto-merge — on an auto-merge repo', () => {
        const [outcome, calls] = merge([0], true);
        expect(outcome.merged).toBe(true);
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
        expect(outcome.message).toContain('did NOT merge');
        expect(outcome.message).toContain('allow_auto_merge');
        expect(calls).toHaveLength(1);
        expect(flat(calls).some((c: string): boolean => c.includes('--auto'))).toBe(false);
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
        expect(outcome.message).toContain('mergeMode is NONE');
        expect(outcome.message).toContain('My PR title (#7)');
    });
});

describe('mergeMode DIRECT — merge when mergeable, never queue', () => {
    it('still merges directly when the PR is mergeable', () => {
        const [outcome, calls] = mergeIn([0], true, MERGE_MODE_DIRECT);
        expect(outcome.merged).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('does NOT fall back to --auto even on a repo that allows it', () => {
        const [outcome, calls] = mergeIn([1], true, MERGE_MODE_DIRECT);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('DIRECT');
        expect(calls).toHaveLength(1);
        expect(flat(calls).some((c: string): boolean => c.includes('--auto'))).toBe(false);
    });
});

describe('an unknown or missing mergeMode', () => {
    it('behaves as DETECT, so an older published rules-config keeps today’s behavior', () => {
        const [outcome, calls] = mergeIn([1, 0], true, '');
        expect(outcome.autoMergeEnabled).toBe(true);
        expect(flat(calls).some((c: string): boolean => c.includes('--auto'))).toBe(true);
    });
});
