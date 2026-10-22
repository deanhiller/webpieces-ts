import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MERGE_MODE_AUTO, MERGE_MODE_NONE } from '@webpieces/rules-config';
import { PROCESS_NOT_STARTED, ProcessResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import {
    PrMerger, MergeIntent, MergeOutcome, PrMergeState,
    MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND_CLEAN, MERGE_RESULT_BEHIND_CONFLICTING, MERGE_RESULT_BEHIND_UNKNOWN, MERGE_RESULT_FAILED,
} from './pr-merger';

// The production PrMerger from the shipped container (#1381), with `gh` SCRIPTED: NO gh, no network, no
// repo. `statuses` answers the non-quiet `gh pr merge` calls in order (the direct merge, then `--auto`);
// the quiet `--disable-auto` always succeeds — the real no-op-when-not-enabled behaviour. `state` is what
// `gh pr view --json mergeable,mergeStateStatus,state` answers; an all-'' state means gh could not answer.
const BRANCH = 'dean/feature';
const SUBJECT = 'My PR title (#7)';
const BODY = '/tmp/body.md';
const NOT_MERGEABLE = 'X Pull request #7 is not mergeable: the head branch is not up to date with the base branch.\n';

let feature: PrGateFeature;
let output: CapturedOutput;
let printed = '';

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
    output = CapturedOutput.start();
});

afterEach((): void => {
    output.stop();
});

// A healthy PR GitHub is happy about — the default for tests that are not about BEHIND.
const CLEAN = new PrMergeState('MERGEABLE', 'CLEAN', 'OPEN');
const BEHIND = new PrMergeState('MERGEABLE', 'BEHIND', 'OPEN');
const BEHIND_CONFLICTING = new PrMergeState('CONFLICTING', 'BEHIND', 'OPEN');
// GitHub's ordinary reply in the seconds after a force-push — it computes mergeability asynchronously.
const BEHIND_UNKNOWN = new PrMergeState('UNKNOWN', 'BEHIND', 'OPEN');

function scriptGitHub(statuses: number[], autoAllowed: boolean, state: PrMergeState): void {
    const gh = feature.processes;
    const direct = statuses[0] ?? 0;
    gh.respond('gh', ['pr', 'merge', BRANCH, '--squash', '--subject', SUBJECT, '--body-file', BODY],
        new ProcessResultDto(direct, '', direct === 0 ? '' : NOT_MERGEABLE));
    gh.respond('gh', ['pr', 'merge', BRANCH, '--auto', '--squash', '--subject', SUBJECT, '--body-file', BODY],
        new ProcessResultDto(statuses[1] ?? 0, '', ''));
    gh.respond('gh', ['pr', 'merge', BRANCH, '--disable-auto'], gh.ok());
    gh.respond('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge'], gh.ok(`${String(autoAllowed)}\n`));
    gh.respondToPrefix('gh', ['pr', 'view', BRANCH], state.state === ''
        ? gh.fail(1, 'HTTP 502')
        : gh.ok(`${state.mergeable}\t${state.mergeStateStatus}\t${state.state}\n`));
}

/** The `gh pr merge` calls the program issued, as argv — the merge decisions it actually made. */
function mergeCalls(): string[][] {
    return feature.processes.callsStartingWith('gh', ['pr', 'merge']).map((c: ProcessCallDto): string[] => [...c.args]);
}

const mergeIntent = async (statuses: number[], autoAllowed: boolean, intent: MergeIntent, state: PrMergeState): Promise<[MergeOutcome, string[][]]> => {
    feature = await PrGateFeature.create();
    scriptGitHub(statuses, autoAllowed, state);
    const before = output.stdout.length;
    const outcome = await feature.container.get(PrMerger).merge(BRANCH, SUBJECT, BODY, intent);
    printed = output.stdout.slice(before);
    return [outcome, mergeCalls()];
};

// The POLICY-driven caller (wp-finish-upsert-pr): `mode` is the config value and nothing else.
const mergeState = (statuses: number[], autoAllowed: boolean, mode: string, state: PrMergeState): Promise<[MergeOutcome, string[][]]> =>
    mergeIntent(statuses, autoAllowed, new MergeIntent(mode, false), state);

// The COMMANDED caller (wp-land-pr): the merge happens whatever `mode` says.
const land = (statuses: number[], autoAllowed: boolean, mode: string): Promise<[MergeOutcome, string[][]]> =>
    mergeIntent(statuses, autoAllowed, new MergeIntent(mode, true), CLEAN);

const mergeIn = (statuses: number[], autoAllowed: boolean, mode: string): Promise<[MergeOutcome, string[][]]> =>
    mergeState(statuses, autoAllowed, mode, CLEAN);

// AUTO — the mode where the tooling is allowed to land the PR.
const merge = (statuses: number[], autoAllowed: boolean): Promise<[MergeOutcome, string[][]]> =>
    mergeIn(statuses, autoAllowed, MERGE_MODE_AUTO);

// Every gh invocation flattened to a string, for asserting which flags were (and were NOT) used.
const flat = (calls: string[][]): string[] => calls.map((c: string[]): string => c.join(' '));

describe('direct merge succeeds', () => {
    it('reports merged and never touches auto-merge — on an auto-merge repo', async () => {
        const [outcome, calls] = await merge([0], true);
        expect(outcome.merged).toBe(true);
        expect(outcome.result).toBe(MERGE_RESULT_MERGED);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('My PR title (#7)');
        expect(flat(calls)).toEqual(['pr merge dean/feature --squash --subject My PR title (#7) --body-file /tmp/body.md']);
    });

    it('reports merged on a repo with auto-merge DISABLED (the direct merge does not need it)', async () => {
        const [outcome, calls] = await merge([0], false);
        expect(outcome.merged).toBe(true);
        expect(calls).toHaveLength(1);
        expect(flat(calls)[0]).not.toContain('--auto');
    });
});

describe('direct merge fails and auto-merge IS allowed', () => {
    it('falls back to --auto with the SAME subject/body, disabling first so the body is re-stamped', async () => {
        const [outcome, calls] = await merge([1, 0], true);
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

    it('a FAILING --auto is reported as a failure, not swallowed (the original bug)', async () => {
        const [outcome] = await merge([1, 1], true);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('did NOT merge');
    });
});

describe('direct merge fails and auto-merge is NOT allowed', () => {
    it('does not fire a --auto that can only error, and says nothing was queued', async () => {
        const [outcome, calls] = await merge([1], false);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.result).toBe(MERGE_RESULT_FAILED);
        expect(outcome.message).toContain('did NOT merge');
        expect(outcome.message).toContain('allow_auto_merge');
        expect(calls).toHaveLength(1);
        expect(flat(calls).some((c: string): boolean => c.includes('--auto'))).toBe(false);
    });

    it('IS a config mismatch when the AUTO was read from config, and names both remedies', async () => {
        const [outcome] = await merge([1], false);
        expect(outcome.message).toContain('CONFIG MISMATCH');
        expect(outcome.message).toContain('pr-gate.mergeMode is AUTO');
    });

    // The wp-land-pr bug: `AUTO` used to be passed as a VERB ("merge it"), and the message then asserted
    // it as a config value — on a repo whose mergeMode is NONE, prescribing remedies already in place.
    it('is NOT a config mismatch when wp-land-pr commanded the merge on a NONE repo', async () => {
        const [outcome, calls] = await land([1], false, MERGE_MODE_NONE);
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
    it('merges on a NONE repo, which is the whole point of the command', async () => {
        const [outcome, calls] = await land([0], false, MERGE_MODE_NONE);
        expect(outcome.merged).toBe(true);
        expect(outcome.result).toBe(MERGE_RESULT_MERGED);
        expect(flat(calls)).toEqual(['pr merge dean/feature --squash --subject My PR title (#7) --body-file /tmp/body.md']);
    });

    it('merges even when the config value is missing entirely', async () => {
        expect((await land([0], false, ''))[0].merged).toBe(true);
    });
});

describe('the PR is BEHIND its base — the outcome that never self-heals', () => {
    it('is reported as BEHIND, not as a queued success, even when --auto is accepted', async () => {
        const [outcome] = await mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND);
        expect(outcome.merged).toBe(false);
        expect(outcome.isBehind()).toBe(true);
        expect(outcome.message).toContain('landed on main first');
        expect(outcome.message).toContain('does NOT self-heal');
        // Still queued: a repo that auto-updates branches can land it, and un-queuing helps nobody.
        expect(outcome.autoMergeEnabled).toBe(true);
    });

    it('is still BEHIND — not a generic failure — when the repo forbids auto-merge', async () => {
        const [outcome] = await mergeState([1], false, MERGE_MODE_AUTO, BEHIND);
        expect(outcome.isBehind()).toBe(true);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(outcome.message).toContain('Nothing is queued');
    });

    // The split that lets the banner stop describing a queue collision as a merge conflict. `mergeable`
    // was always fetched here; until now it was fetched and thrown away.
    it('classifies a clean collision, a real conflict and an uncomputed answer as THREE outcomes', async () => {
        expect((await mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND))[0].result).toBe(MERGE_RESULT_BEHIND_CLEAN);
        expect((await mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND_CONFLICTING))[0].result).toBe(MERGE_RESULT_BEHIND_CONFLICTING);
        expect((await mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND_UNKNOWN))[0].result).toBe(MERGE_RESULT_BEHIND_UNKNOWN);
    });

    it('never reads UNKNOWN as "no conflicts" — that would promise a clean re-run we cannot see', async () => {
        const [outcome] = await mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND_UNKNOWN);
        expect(outcome.result).not.toBe(MERGE_RESULT_BEHIND_CLEAN);
        expect(outcome.isBehind()).toBe(true);
    });

    it('carries GitHub\'s own verdict verbatim, so nobody has to pattern-match gh prose', async () => {
        const [outcome] = await mergeState([1, 0], true, MERGE_MODE_AUTO, BEHIND);
        expect(outcome.message).toContain('mergeStateStatus=BEHIND');
        expect(outcome.message).toContain('mergeable=MERGEABLE');
    });

    it('an unreadable gh answer is NEVER diagnosed as BEHIND — it falls through as normal', async () => {
        const [outcome] = await mergeState([1, 0], true, MERGE_MODE_AUTO, new PrMergeState('', '', ''));
        expect(outcome.result).toBe(MERGE_RESULT_AUTO_QUEUED);
    });
});

describe('the expected first-attempt failure is framed, not dumped raw', () => {
    it('captures gh\'s `X …` line and reprints it as context plus a retry announcement', async () => {
        await mergeState([1, 0], true, MERGE_MODE_AUTO, CLEAN);
        expect(printed).toContain('the direct squash-merge did not go through');
        expect(printed).toContain('retrying with --auto');
        // The reason is still shown — framed, never hidden.
        expect(printed).toContain('X Pull request #7 is not mergeable');
    });

    it('says nothing about a retry when the direct merge worked', async () => {
        await mergeState([0], true, MERGE_MODE_AUTO, CLEAN);
        expect(printed).not.toContain('retrying with --auto');
    });
});

describe('gh cannot be spawned at all', () => {
    it('a not-started status is a failure, never mistaken for the 0 that means success', async () => {
        const [outcome] = await merge([PROCESS_NOT_STARTED], false);
        expect(outcome.merged).toBe(false);
        expect(outcome.message).toContain('did NOT merge');
    });
});

describe('mergeMode NONE — "a human clicks merge" repos', () => {
    it('runs NO gh merge command at all, even when the PR is perfectly mergeable', async () => {
        const [outcome, calls] = await mergeIn([0], true, MERGE_MODE_NONE);
        expect(outcome.merged).toBe(false);
        expect(outcome.autoMergeEnabled).toBe(false);
        expect(calls).toEqual([]);
    });

    it('still reports the subject GitHub should use, so the human merge can be checked', async () => {
        const [outcome] = await mergeIn([0], true, MERGE_MODE_NONE);
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
    it('names both squash_merge_commit_* settings, as pinned rather than as homework', async () => {
        const [outcome] = await mergeIn([0], true, MERGE_MODE_NONE);
        expect(outcome.message).toContain('squash_merge_commit_title=PR_TITLE');
        expect(outcome.message).toContain('squash_merge_commit_message=PR_BODY');
        // Offered as the CLI alternative, never as a correction to clicking Merge.
        expect(outcome.message).toContain('pnpm wp-land-pr');
        expect(outcome.message).not.toContain('whole dashboard');
        // SquashSettingsEnforcer repairs both on every run, so this must not read as a chore for the
        // reader. "both must be set" was true for exactly one release; it is homework nobody owes now.
        expect(outcome.message).not.toContain('both must be');
        expect(outcome.message).toContain('Nothing to set up');
        expect(outcome.message).not.toContain('left for a human');
        expect(outcome.message).toContain('does not require additional authorization');
        expect(outcome.message).toContain('$full-cycle');
    });
});

describe('an unknown or missing mergeMode — the fail-safe', () => {
    it('does NOT merge, because an unreadable policy must never be read as permission to touch main', async () => {
        const [outcome, calls] = await mergeIn([0], true, '');
        expect(outcome.merged).toBe(false);
        expect(calls).toEqual([]);
        expect(outcome.message).toContain('did NOT merge');
    });
});
