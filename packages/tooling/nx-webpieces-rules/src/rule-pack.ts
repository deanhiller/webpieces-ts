import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { RULE_SCHEMAS } from '@webpieces/rules-config';
import { version } from '../package.json';

/** Compatibility manifest; executable registries remain authoritative until ownership migration. */
const ownedRuleIds = [
    "no-file-import-cycles",
    "runtime-architecture",
    "nx-wiring",
    "di-graph",
    "missing-design-annotation",
    "validate-architecture-unchanged",
    "validate-no-architecture-cycles",
    "validate-packagejson",
    "validate-versions-locked",
    "validate-eslint-sync",
    "no-root-union-api-type",
    "api-rules-for-openapi",
    "api-rules-for-mcp",
    "api-lib-dependencies",
    "api-lib-path",
    "framework-folder"
] as const;

export const rulePackManifest = new RulePackManifest(
    '@webpieces/nx-webpieces-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRuleIds.map(id => new OwnedRuleDefinition(id, RULE_SCHEMAS[id], RULE_SCHEMA_API_VERSION)),
    [
        ...ownedRuleIds.map(id => new RuleContribution(id, '@webpieces/nx-webpieces-rules', 'build')),
        new RuleContribution('validate-ts-in-src', '@webpieces/ai-hook-rules', 'build'),
    ],
);
