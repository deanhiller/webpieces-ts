import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION, FieldDef, BASE_RULE_SCHEMA } from '@webpieces/rules-sdk';
import { version } from '../package.json';

/** Compatibility manifest; executable registries remain authoritative until ownership migration. */
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
    ownedRuleIds.map(id => new OwnedRuleDefinition(id, { mode: new FieldDef('string', ['ON', 'OFF']), ...BASE_RULE_SCHEMA }, RULE_SCHEMA_API_VERSION)),
    [
        ...ownedRuleIds.map(id => new RuleContribution(id, '@webpieces/eslint-rules', 'lint')),
        new RuleContribution('catch-error-pattern', '@webpieces/code-rules', 'lint'),
        new RuleContribution('no-unmanaged-exceptions', '@webpieces/code-rules', 'lint'),
        new RuleContribution('max-method-lines', '@webpieces/code-rules', 'lint'),
        new RuleContribution('max-file-lines', '@webpieces/code-rules', 'lint'),
    ],
);
