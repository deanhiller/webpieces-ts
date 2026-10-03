import { ConfigObject } from '@webpieces/rules-sdk';

/** Optional knobs only. Required behaviour is always supplied by the repository. */
export const optionalTuning: Readonly<Record<string, ConfigObject>> = {
    "branch-creation-guard": {},
    "pr-lifecycle-guard": {},
    "branch-state-guard": {}
};

/** Written for review by setup/sync; never used as a loader fallback. */
export const recommendedSeeds: Readonly<Record<string, ConfigObject>> = {
    "branch-creation-guard": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "subBranchNaming": "feature/<ticket>/<short-description>",
        "autoReapMergedBranches": false
    },
    "pr-lifecycle-guard": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "branch-state-guard": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "maxCommitsBehind": 5
    }
};
