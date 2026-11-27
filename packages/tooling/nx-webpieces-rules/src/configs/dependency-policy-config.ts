import { BaseRuleConfig, FieldDef, SchemaShape } from '@webpieces/rules-sdk';
import { STRUCTURAL_MODES, StructuralMode } from './rule-configs';

export class DependencyCatalogConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    static readonly SCHEMA: SchemaShape<DependencyCatalogConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
    };
}

export class RootRuntimeFreezeConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    allowedNames?: string[];
    static readonly SCHEMA: SchemaShape<RootRuntimeFreezeConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        allowedNames: new FieldDef('string[]'),
    };
}

export class DependencyOwnershipConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    rootToolPaths?: string[];
    testPaths?: string[];
    artifactProbePaths?: string[];
    toolProviders?: string[];
    dynamicImports?: string[];
    static readonly SCHEMA: SchemaShape<DependencyOwnershipConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        rootToolPaths: new FieldDef('string[]'),
        testPaths: new FieldDef('string[]'),
        artifactProbePaths: new FieldDef('string[]'),
        toolProviders: new FieldDef('string[]'),
        dynamicImports: new FieldDef('string[]'),
    };
}
