import { optionalTuning, recommendedSeeds } from './rule-settings';
import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { version } from '../package.json';
import { LintRuleConfig } from './lint-rule-config';

/** Lint-only policies own their explicit schema and contribute to the code-owned policies. */
const ownedRuleIds = [
    "enforce-architecture",
    "no-json-property-primitive-type",
    "require-typed-template",
    "no-mat-cell-def"
] as const;

export const rulePackManifest = new RulePackManifest(
    '@webpieces/eslint-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRuleIds.map(id => new OwnedRuleDefinition(id, LintRuleConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning[id], recommendedSeeds[id], 'lint')),
    [
        ...ownedRuleIds.map(id => new RuleContribution(id, '@webpieces/eslint-rules', 'lint')),
        new RuleContribution('catch-error-pattern', '@webpieces/code-rules', 'lint'),
        new RuleContribution('no-unmanaged-exceptions', '@webpieces/code-rules', 'lint'),
        new RuleContribution('max-method-lines', '@webpieces/code-rules', 'lint'),
        new RuleContribution('max-file-lines', '@webpieces/code-rules', 'lint'),
    ],
    [],
    [],
);
