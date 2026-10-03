import { OnOffMode, ON_OFF_MODES } from "@webpieces/rules-sdk";
import { BaseRuleConfig, BASE_RULE_SCHEMA } from "@webpieces/rules-sdk";
import { FieldDef, SchemaShape } from "@webpieces/rules-sdk";
// branch-creation-guard modes. ON_NO_SUBBRANCHES is the strict variant: it hard-blocks
// creating a branch off any non-main branch (no sub-branch affordance), pointing the agent
// back to `git checkout main && git pull && git checkout -b <branch>`. Temporarily overridable
// via the universal turnOffRuleUntilEpoch escape hatch.
export const BRANCH_GUARD_MODES = ['ON', 'OFF', 'ON_NO_SUBBRANCHES'] as const;

export type BranchGuardMode = typeof BRANCH_GUARD_MODES[number];

export class BranchCreationGuardConfig extends BaseRuleConfig {
    declare mode?: BranchGuardMode;
    // Naming pattern for stacked SUB-branches only (branches created off another feature branch,
    // which require human approval). Never applied to branches created off main.
    //
    // Schema-REQUIRED (#1017), like `mode` and `autoReapMergedBranches`, and for the same reason: it
    // is BEHAVIOUR, not a knob. This string decides which branch names the guard BLOCKS, and the
    // refusal quotes it back at the agent as the convention to follow — so a repo running webpieces'
    // shipped value is a repo whose branch-naming convention was chosen by a framework author who
    // never saw it. TS-optional but schema-required, the split `mode` uses: absent at RUNTIME means
    // the config never passed validation.
    subBranchNaming!: string;
    // Human-sentence instruction telling the AI how to name a NEW branch off main. Surfaced back
    // to the agent in the guard's fix hints. May mirror no-edit-on-main.branchNamingConvention.
    branchFormat?: string;
    // Hard cap on local feature branches (excluding main). Creating one past the cap is BLOCKED until
    // already-merged branches are reaped, which is what keeps the branch list from growing without
    // bound. Branch creation is the gate because it is the only moment cleanup is both cheap and
    // obviously worth it. See merged-branches.ts for how "already merged" is determined.
    maxLocalBranches?: number;
    // Hard cap on LINKED worktrees (the primary clone is never counted). A separate budget from
    // maxLocalBranches: every worktree holds a branch, so if worktree-held branches also spent the
    // branch budget, five worktrees would leave room for zero branches. Held branches count here;
    // parked branches count against maxLocalBranches. Enforced at `git worktree add`.
    maxWorktrees?: number;
    // Let the detached background refresher DELETE dead branches on its own, instead of only
    // reporting them. Every candidate is provably dead (a MERGED PR — its own, or the PR of the branch
    // it snapshots; nothing else qualifies) and
    // recoverable by the SHA logged to branch-mutations.log — but it is still UNATTENDED deletion,
    // so this is schema-REQUIRED like `mode` and `turnOffRuleUntilEpoch`. "Every built-in rule
    // must be explicitly configured — no silent defaults" (validate-config.ts) applies with extra
    // force here: branches disappearing on a preference nobody ever stated is precisely the kind of
    // default that must not exist. Validation makes each consumer answer the question once.
    //
    // TS-optional but schema-required — the same split `mode` uses. Absent at RUNTIME therefore means
    // the config never passed validation, and the only safe reading of "nobody has answered" is: do
    // not delete anything.
    autoReapMergedBranches?: boolean;

    static readonly SCHEMA: SchemaShape<BranchCreationGuardConfig> = {
        mode: new FieldDef('string', BRANCH_GUARD_MODES),
        subBranchNaming: new FieldDef('string'),
        branchFormat: FieldDef.optional('string'),
        maxLocalBranches: FieldDef.optional('number'),
        maxWorktrees: FieldDef.optional('number'),
        autoReapMergedBranches: new FieldDef('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

/**
 * `pr-lifecycle-guard` — ONE key, ONE policy: *PRs and merges go through the gated flow.*
 *
 * Four CLASSES implement it, and their names are unchanged (they are the operator identity every
 * decision-log line and every deny report carries):
 *
 *   pr-creation-or-push-guard  a manual `git push` / `gh pr create|edit` / a raw pulls API call
 *   merge-in-progress-guard    a PR command while a 3-point merge is half-finished
 *   pr-merge-guard             a bare `gh pr merge`
 *   redirect-how-to-merge-main "how do I get main into my branch?" → the documented flow
 *
 * ## Say this out loud: `"mode": "OFF"` releases the unvalidated-merge gate too
 *
 * Three of the four are pure COMMAND-SHAPE blocks and can never fire spuriously. The fourth,
 * merge-in-progress-guard, is STATE-conditional — it fires only while a 3-point merge is actually in
 * progress, and it is the one state L2 explicitly stands down for. So turning this key OFF to unblock
 * `gh pr merge` ALSO drops the "you have an unfinished merge" gate. That is the honest cost of one key
 * per policy, and it is stated here, in guards/L4-pr-lifecycle.md, and in the error path, rather than
 * being papered over with a granular sub-mode (which would be four knobs wearing one key's name).
 *
 * ## The command strings are NOT here
 *
 * `upsertPrCommand` and `mergeCompleteCommand` used to sit on the two guards, and — being read at the
 * point of use — they BEAT `commands.guardHints`, so `guardHintsWhy`'s claim that renaming a gated
 * command there makes "every guard message follow" was simply false. They are DELETED, not deprecated.
 * `commands.guardHints.prCreationOrPush` / `.mergeInProgress` is the one place those strings live, and
 * the loader hands the resolved values to the two rules directly. A consumer that still sets the old
 * per-guard field gets a RETIRED_FIELD_HINTS error naming the destination.
 */
export class PrLifecycleGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<PrLifecycleGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}
