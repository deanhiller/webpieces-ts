import { ConfigObject } from '@webpieces/rules-sdk';

/** Optional knobs only. Required behaviour is always supplied by the repository. */
export const optionalTuning: Readonly<Record<string, ConfigObject>> = {
    "enforce-architecture": {},
    "no-json-property-primitive-type": {},
    "require-typed-template": {},
    "no-mat-cell-def": {}
};

/** Written for review by setup/sync; never used as a loader fallback. */
export const recommendedSeeds: Readonly<Record<string, ConfigObject>> = {
    "enforce-architecture": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-json-property-primitive-type": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "require-typed-template": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-mat-cell-def": {
        "mode": "ON",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    }
};
