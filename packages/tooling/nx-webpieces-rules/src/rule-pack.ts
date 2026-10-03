import { ruleMigrations } from './rule-migrations';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import { OwnedRuleDefinition, RuleContribution, RulePackManifest, RULE_PACK_API_VERSION, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { NoFileImportCyclesConfig, RuntimeArchitectureConfig, NxWiringConfig, DiGraphConfig, MissingDesignAnnotationConfig, ValidateArchitectureUnchangedConfig, ValidateNoArchitectureCyclesConfig, ValidatePackageJsonConfig, ValidateVersionsLockedConfig, ValidateEslintSyncConfig } from './configs/rule-configs';
import { NoRootUnionApiTypeConfig } from './configs/no-root-union-config';
import { ApiRulesForOpenApiConfig, ApiRulesForMcpConfig } from './configs/api-doc-rules-config';
import { ApiLibDependenciesConfig, ApiLibPathConfig, FrameworkFolderConfig } from './configs/tag-truth-configs';
import { version } from '../package.json';

/** Native Nx policies publish their concrete owner schemas. */
const ownedRules = [
    new OwnedRuleDefinition('no-file-import-cycles', NoFileImportCyclesConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['no-file-import-cycles'], recommendedSeeds['no-file-import-cycles'], 'rules'),
    new OwnedRuleDefinition('runtime-architecture', RuntimeArchitectureConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['runtime-architecture'], recommendedSeeds['runtime-architecture'], 'rules'),
    new OwnedRuleDefinition('nx-wiring', NxWiringConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['nx-wiring'], recommendedSeeds['nx-wiring'], 'rules'),
    new OwnedRuleDefinition('di-graph', DiGraphConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['di-graph'], recommendedSeeds['di-graph'], 'rules'),
    new OwnedRuleDefinition('missing-design-annotation', MissingDesignAnnotationConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['missing-design-annotation'], recommendedSeeds['missing-design-annotation'], 'rules'),
    new OwnedRuleDefinition('validate-architecture-unchanged', ValidateArchitectureUnchangedConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['validate-architecture-unchanged'], recommendedSeeds['validate-architecture-unchanged'], 'rules'),
    new OwnedRuleDefinition('validate-no-architecture-cycles', ValidateNoArchitectureCyclesConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['validate-no-architecture-cycles'], recommendedSeeds['validate-no-architecture-cycles'], 'rules'),
    new OwnedRuleDefinition('validate-packagejson', ValidatePackageJsonConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['validate-packagejson'], recommendedSeeds['validate-packagejson'], 'rules'),
    new OwnedRuleDefinition('validate-versions-locked', ValidateVersionsLockedConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['validate-versions-locked'], recommendedSeeds['validate-versions-locked'], 'rules'),
    new OwnedRuleDefinition('validate-eslint-sync', ValidateEslintSyncConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['validate-eslint-sync'], recommendedSeeds['validate-eslint-sync'], 'rules'),
    new OwnedRuleDefinition('no-root-union-api-type', NoRootUnionApiTypeConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['no-root-union-api-type'], recommendedSeeds['no-root-union-api-type'], 'rules'),
    new OwnedRuleDefinition('api-rules-for-openapi', ApiRulesForOpenApiConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['api-rules-for-openapi'], recommendedSeeds['api-rules-for-openapi'], 'rules'),
    new OwnedRuleDefinition('api-rules-for-mcp', ApiRulesForMcpConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['api-rules-for-mcp'], recommendedSeeds['api-rules-for-mcp'], 'rules'),
    new OwnedRuleDefinition('api-lib-dependencies', ApiLibDependenciesConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['api-lib-dependencies'], recommendedSeeds['api-lib-dependencies'], 'rules'),
    new OwnedRuleDefinition('api-lib-path', ApiLibPathConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['api-lib-path'], recommendedSeeds['api-lib-path'], 'rules'),
    new OwnedRuleDefinition('framework-folder', FrameworkFolderConfig.SCHEMA, RULE_SCHEMA_API_VERSION, optionalTuning['framework-folder'], recommendedSeeds['framework-folder'], 'rules'),
];

export const rulePackManifest = new RulePackManifest(
    '@webpieces/nx-webpieces-rules',
    version,
    RULE_PACK_API_VERSION,
    ownedRules,
    [
        ...ownedRules.map(rule => new RuleContribution(rule.id, '@webpieces/nx-webpieces-rules', 'build')),
        new RuleContribution('validate-ts-in-src', '@webpieces/ai-hook-rules', 'build'),
    ],
    ruleMigrations,
    [],
);
