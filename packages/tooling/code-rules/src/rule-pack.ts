import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { RULE_SCHEMAS } from '@webpieces/rules-config';
import { version } from '../package.json';

/** Compatibility manifest; executable registries remain authoritative until ownership migration. */
const ownedRuleIds = [
    "max-method-lines",
    "max-file-lines",
    "require-return-type",
    "no-inline-type-literals",
    "no-any-unknown",
    "no-implicit-any",
    "prisma-validate-dtos",
    "prisma-converter",
    "no-destructure",
    "catch-error-pattern",
    "no-unmanaged-exceptions",
    "angular-no-direct-api-in-resolver",
    "no-symbol-di-tokens",
    "no-client-creation-outside-server-or-client",
    "no-custom-css",
    "no-state-paths-in-templates",
    "no-process-exit-outside-main",
    "no-function-outside-class",
    "inject-annotation-not-needed-for-concrete-class",
    "framework-tag",
    "role-tag",
    "ensure-we-are-secure",
    "no-inline-import-in-api-lib",
    "one-enum-spelling-in-api-lib",
    "no-utility-types-in-api-lib",
    "required-type-suffix",
    "framework-tsconfig",
    "framework-packages"
] as const;

export const rulePackManifest = new RulePackManifest(
    '@webpieces/code-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRuleIds.map(id => new OwnedRuleDefinition(id, RULE_SCHEMAS[id], RULE_SCHEMA_API_VERSION)),
    [
        ...ownedRuleIds.map(id => new RuleContribution(id, '@webpieces/code-rules', 'build')),

    ],
);
