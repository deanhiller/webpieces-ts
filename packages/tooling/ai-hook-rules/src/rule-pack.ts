import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { RULE_SCHEMAS } from '@webpieces/rules-config';
import { version } from '../package.json';

/** Compatibility manifest; executable registries remain authoritative until ownership migration. */
const ownedRuleIds = [
    "throw-cause-required",
    "no-js-files",
    "validate-ts-in-src"
] as const;

export const rulePackManifest = new RulePackManifest(
    '@webpieces/ai-hook-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRuleIds.map(id => new OwnedRuleDefinition(id, RULE_SCHEMAS[id], RULE_SCHEMA_API_VERSION)),
    [
        ...ownedRuleIds.map(id => new RuleContribution(id, '@webpieces/ai-hook-rules', 'source-hook')),
        new RuleContribution('no-any-unknown', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-implicit-any', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('max-file-lines', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-destructure', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('require-return-type', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-unmanaged-exceptions', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('catch-error-pattern', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-symbol-di-tokens', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-custom-css', '@webpieces/code-rules', 'source-hook'),
        new RuleContribution('no-process-exit-outside-main', '@webpieces/code-rules', 'source-hook'),
    ],
);
