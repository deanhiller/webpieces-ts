import { ConfigObject } from '@webpieces/rules-sdk';

/** Optional knobs only. Required behaviour is always supplied by the repository. */
export const optionalTuning: Readonly<Record<string, ConfigObject>> = {
    "no-file-import-cycles": {},
    "runtime-architecture": {},
    "nx-wiring": {},
    "di-graph": {},
    "missing-design-annotation": {},
    "validate-architecture-unchanged": {},
    "validate-no-architecture-cycles": {},
    "validate-packagejson": {},
    "validate-versions-locked": {},
    "validate-eslint-sync": {},
    "no-root-union-api-type": {},
    "api-rules-for-openapi": {},
    "api-rules-for-mcp": {},
    "api-lib-dependencies": {},
    "api-lib-path": {},
    "framework-folder": {}
};

/** Written for review by setup/sync; never used as a loader fallback. */
export const recommendedSeeds: Readonly<Record<string, ConfigObject>> = {
    "no-file-import-cycles": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "runtime-architecture": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "nx-wiring": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "di-graph": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "missing-design-annotation": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "validate-architecture-unchanged": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "validate-no-architecture-cycles": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "validate-packagejson": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "validate-versions-locked": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "validate-eslint-sync": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-root-union-api-type": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "api-rules-for-openapi": {
        "mode": "AFFECTED_PROJECT",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "api-rules-for-mcp": {
        "mode": "AFFECTED_PROJECT",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "api-lib-dependencies": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "apiLibPackages": [
            "@webpieces/core-util",
            "tslib"
        ],
        "apiClients": []
    },
    "api-lib-path": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "paths": [
            "libraries/apis/**"
        ]
    },
    "framework-folder": {
        "mode": "RUN_EVERY_TIME",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "entries": [
            {
                "paths": [
                    "libraries/angular/**"
                ],
                "frameworkSets": [
                    "angular"
                ],
                "roles": [
                    "lib",
                    "designed-lib"
                ]
            },
            {
                "paths": [
                    "libraries/node/**"
                ],
                "frameworkSets": [
                    "node",
                    "express"
                ],
                "roles": [
                    "lib",
                    "designed-lib"
                ]
            },
            {
                "paths": [
                    "libraries/universal/**"
                ],
                "frameworkSets": [
                    "browser+node+react-native"
                ],
                "roles": [
                    "lib",
                    "designed-lib"
                ]
            },
            {
                "paths": [
                    "libraries/rn-browser/**"
                ],
                "frameworkSets": [
                    "browser+react-native"
                ],
                "roles": [
                    "lib",
                    "designed-lib"
                ]
            },
            {
                "paths": [
                    "libraries/react-native/**"
                ],
                "frameworkSets": [
                    "react-native"
                ],
                "roles": [
                    "lib",
                    "designed-lib"
                ]
            },
            {
                "paths": [
                    "libraries/apis/internal/**"
                ],
                "frameworkSets": [
                    "browser+node+react-native"
                ],
                "roles": [
                    "api-lib"
                ]
            },
            {
                "paths": [
                    "libraries/apis/external-node/**"
                ],
                "frameworkSets": [
                    "node"
                ],
                "roles": [
                    "api-client"
                ]
            },
            {
                "paths": [
                    "libraries/apis/external-rn-browser/**"
                ],
                "frameworkSets": [
                    "browser+react-native"
                ],
                "roles": [
                    "api-lib"
                ]
            }
        ]
    }
};
