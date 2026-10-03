import { ConfigObject } from '@webpieces/rules-sdk';

/** Optional knobs only. Required behaviour is always supplied by the repository. */
export const optionalTuning: Readonly<Record<string, ConfigObject>> = {
    "max-method-lines": {
        "limit": 80
    },
    "max-file-lines": {
        "limit": 900
    },
    "require-return-type": {},
    "no-inline-type-literals": {},
    "no-any-unknown": {},
    "no-implicit-any": {},
    "prisma-validate-dtos": {},
    "prisma-converter": {},
    "no-destructure": {
        "allowTopLevel": true
    },
    "catch-error-pattern": {},
    "no-unmanaged-exceptions": {},
    "angular-no-direct-api-in-resolver": {},
    "no-symbol-di-tokens": {},
    "no-client-creation-outside-server-or-client": {},
    "no-custom-css": {
        "allowGlobs": []
    },
    "no-state-paths-in-templates": {},
    "no-process-exit-outside-main": {},
    "no-function-outside-class": {},
    "inject-annotation-not-needed-for-concrete-class": {},
    "framework-tag": {
        "knownTypes": [
            "browser",
            "react",
            "angular",
            "node",
            "express",
            "react-native"
        ]
    },
    "role-tag": {
        "knownTypes": [
            "server",
            "app",
            "bundle",
            "designed-lib",
            "lib",
            "client",
            "api-lib",
            "api-client"
        ]
    },
    "ensure-we-are-secure": {},
    "no-inline-import-in-api-lib": {},
    "one-enum-spelling-in-api-lib": {},
    "no-utility-types-in-api-lib": {},
    "required-type-suffix": {},
    "framework-tsconfig": {},
    "framework-packages": {}
};

/** Written for review by setup/sync; never used as a loader fallback. */
export const recommendedSeeds: Readonly<Record<string, ConfigObject>> = {
    "max-method-lines": {
        "mode": "NEW_AND_MODIFIED_METHODS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "max-file-lines": {
        "mode": "NEW_AND_MODIFIED_FILES",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "require-return-type": {
        "mode": "NEW_AND_MODIFIED_METHODS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-inline-type-literals": {
        "mode": "NEW_AND_MODIFIED_METHODS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-any-unknown": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-implicit-any": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "prisma-validate-dtos": {
        "mode": "MODIFIED_CLASS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "prisma-converter": {
        "mode": "NEW_AND_MODIFIED_METHODS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-destructure": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "catch-error-pattern": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-unmanaged-exceptions": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "angular-no-direct-api-in-resolver": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-symbol-di-tokens": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-client-creation-outside-server-or-client": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-custom-css": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-state-paths-in-templates": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-process-exit-outside-main": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-function-outside-class": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "inject-annotation-not-needed-for-concrete-class": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "framework-tag": {
        "mode": "MODIFIED_PROJECTS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "role-tag": {
        "mode": "MODIFIED_PROJECTS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "ensure-we-are-secure": {
        "mode": "MODIFIED_PROJECTS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-inline-import-in-api-lib": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "one-enum-spelling-in-api-lib": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "no-utility-types-in-api-lib": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "paths": [
            "libraries/apis/**"
        ]
    },
    "required-type-suffix": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "entries": [
            {
                "paths": [
                    "libraries/apis/**"
                ],
                "suffixes": [
                    "Request",
                    "Response",
                    "Event",
                    "Dto",
                    "Api"
                ]
            }
        ]
    },
    "framework-tsconfig": {
        "mode": "MODIFIED_PROJECTS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    },
    "framework-packages": {
        "mode": "MODIFIED_PROJECTS",
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null,
        "entries": [
            {
                "packages": [
                    "@angular/*"
                ],
                "frameworks": [
                    "angular"
                ]
            },
            {
                "packages": [
                    "react",
                    "react-native",
                    "expo*",
                    "@expo/*",
                    "@sentry/react-native"
                ],
                "frameworks": [
                    "react",
                    "react-native"
                ]
            },
            {
                "packages": [
                    "express",
                    "firebase-admin",
                    "googleapis",
                    "google-auth-library",
                    "@google-cloud/*"
                ],
                "frameworks": [
                    "node",
                    "express"
                ]
            },
            {
                "packages": [
                    "firebase"
                ],
                "frameworks": [
                    "browser",
                    "angular",
                    "react"
                ]
            }
        ]
    }
};
