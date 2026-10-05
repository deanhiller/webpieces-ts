import { ruleHelp } from './rule-help';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import { OwnedRuleDefinition, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import {
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NxWiringConfig,
    DiGraphConfig,
    MissingDesignAnnotationConfig,
    ValidateArchitectureUnchangedConfig,
    ValidateNoArchitectureCyclesConfig,
    ValidatePackageJsonConfig,
    ValidateVersionsLockedConfig,
    ValidateEslintSyncConfig,
} from './configs/rule-configs';
import { NoRootUnionApiTypeConfig } from './configs/no-root-union-config';
import { ApiRulesForOpenApiConfig, ApiRulesForMcpConfig } from './configs/api-doc-rules-config';
import {
    ApiLibDependenciesConfig,
    ApiLibPathConfig,
    FrameworkFolderConfig,
} from './configs/tag-truth-configs';
import { NativeActions, NativeAction } from './native-actions';
import { WiringFormatConfig } from './configs/wiring-format-config';

export class NxPolicy {
    constructor(
        readonly definition: OwnedRuleDefinition,
        readonly action: NativeAction,
    ) {}
}

const actions = new NativeActions();
export const NX_POLICIES: readonly NxPolicy[] = [
    new NxPolicy(
        new OwnedRuleDefinition('wiring-format', WiringFormatConfig.SCHEMA, RULE_SCHEMA_API_VERSION,
            optionalTuning['wiring-format'], recommendedSeeds['wiring-format'], 'rules', ruleHelp['wiring-format']),
        actions.wiringFormat,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'no-file-import-cycles',
            NoFileImportCyclesConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['no-file-import-cycles'],
            recommendedSeeds['no-file-import-cycles'],
            'rules',
            ruleHelp['no-file-import-cycles'],
        ),
        actions.fileCycles,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'runtime-architecture',
            RuntimeArchitectureConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['runtime-architecture'],
            recommendedSeeds['runtime-architecture'],
            'rules',
            ruleHelp['runtime-architecture'],
        ),
        actions.runtime,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'nx-wiring',
            NxWiringConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['nx-wiring'],
            recommendedSeeds['nx-wiring'],
            'rules',
            ruleHelp['nx-wiring'],
        ),
        actions.wiring,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'di-graph',
            DiGraphConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['di-graph'],
            recommendedSeeds['di-graph'],
            'rules',
            ruleHelp['di-graph'],
        ),
        actions.design,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'missing-design-annotation',
            MissingDesignAnnotationConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['missing-design-annotation'],
            recommendedSeeds['missing-design-annotation'],
            'rules',
            ruleHelp['missing-design-annotation'],
        ),
        actions.design,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'validate-architecture-unchanged',
            ValidateArchitectureUnchangedConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['validate-architecture-unchanged'],
            recommendedSeeds['validate-architecture-unchanged'],
            'rules',
            ruleHelp['validate-architecture-unchanged'],
        ),
        actions.architecture,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'validate-no-architecture-cycles',
            ValidateNoArchitectureCyclesConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['validate-no-architecture-cycles'],
            recommendedSeeds['validate-no-architecture-cycles'],
            'rules',
            ruleHelp['validate-no-architecture-cycles'],
        ),
        actions.cycles,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'validate-packagejson',
            ValidatePackageJsonConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['validate-packagejson'],
            recommendedSeeds['validate-packagejson'],
            'rules',
            ruleHelp['validate-packagejson'],
        ),
        actions.packageJson,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'validate-versions-locked',
            ValidateVersionsLockedConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['validate-versions-locked'],
            recommendedSeeds['validate-versions-locked'],
            'rules',
            ruleHelp['validate-versions-locked'],
        ),
        actions.versions,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'validate-eslint-sync',
            ValidateEslintSyncConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['validate-eslint-sync'],
            recommendedSeeds['validate-eslint-sync'],
            'rules',
            ruleHelp['validate-eslint-sync'],
        ),
        actions.eslintSync,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'no-root-union-api-type',
            NoRootUnionApiTypeConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['no-root-union-api-type'],
            recommendedSeeds['no-root-union-api-type'],
            'rules',
            ruleHelp['no-root-union-api-type'],
        ),
        actions.graphPolicies,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'api-rules-for-openapi',
            ApiRulesForOpenApiConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['api-rules-for-openapi'],
            recommendedSeeds['api-rules-for-openapi'],
            'rules',
            ruleHelp['api-rules-for-openapi'],
        ),
        actions.graphPolicies,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'api-rules-for-mcp',
            ApiRulesForMcpConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['api-rules-for-mcp'],
            recommendedSeeds['api-rules-for-mcp'],
            'rules',
            ruleHelp['api-rules-for-mcp'],
        ),
        actions.graphPolicies,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'api-lib-dependencies',
            ApiLibDependenciesConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['api-lib-dependencies'],
            recommendedSeeds['api-lib-dependencies'],
            'rules',
            ruleHelp['api-lib-dependencies'],
        ),
        actions.graphPolicies,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'api-lib-path',
            ApiLibPathConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['api-lib-path'],
            recommendedSeeds['api-lib-path'],
            'rules',
            ruleHelp['api-lib-path'],
        ),
        actions.graphPolicies,
    ),
    new NxPolicy(
        new OwnedRuleDefinition(
            'framework-folder',
            FrameworkFolderConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning['framework-folder'],
            recommendedSeeds['framework-folder'],
            'rules',
            ruleHelp['framework-folder'],
        ),
        actions.graphPolicies,
    ),
];
