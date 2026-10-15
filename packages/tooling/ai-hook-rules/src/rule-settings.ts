import { ConfigObject } from '@webpieces/rules-sdk';

/** Optional knobs only. Required behaviour is always supplied by the repository. */
export const optionalTuning: Readonly<Record<string, ConfigObject>> = {
    "throw-cause-required": {},
    "no-js-files": {},
    "validate-ts-in-src": {
        "allowedRootFiles": [
            "jest.setup.ts"
        ]
    }
};

/** Written for review by setup/sync; never used as a loader fallback. */
export const recommendedSeeds: Readonly<Record<string, ConfigObject>> = {
    "throw-cause-required": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-js-files": {
        "mode": "NEW_AND_MODIFIED_FILES",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "validate-ts-in-src": {
        "mode": "NEW_AND_MODIFIED_FILES",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    }
};
