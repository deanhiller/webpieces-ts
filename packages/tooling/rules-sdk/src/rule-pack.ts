import { FieldDef } from './field-def';

/** Versioned independently from npm releases: incompatible contracts require an explicit bump. */
export const RULE_PACK_API_VERSION = 1;
export const RULE_SCHEMA_API_VERSION = 1;
export type ExecutionKind = 'build' | 'source-hook' | 'workflow-guard' | 'lint';
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigObject;
export class ConfigObject {
    [key: string]: ConfigValue;
}

/** The single owner supplies the configuration schema, regardless of implementation count. */
export class OwnedRuleDefinition {
    constructor(
        readonly id: string,
        readonly schema: Readonly<Record<string, FieldDef>>,
        readonly schemaApiVersion: number,
    ) {}
}

/** Each pack may implement an owned rule or contribute an execution kind to another owner. */
export class RuleContribution {
    constructor(
        readonly ruleId: string,
        readonly ownerPack: string,
        readonly executionKind: ExecutionKind,
    ) {}
}

export class RulePackManifest {
    constructor(
        readonly packageName: string,
        readonly packageVersion: string,
        readonly apiVersion: number,
        readonly ownedRules: readonly OwnedRuleDefinition[],
        readonly contributions: readonly RuleContribution[],
    ) {}
}

/** Explicit module declarations let a client add packs without a central built-in package list. */
export class RulePackDeclaration {
    constructor(readonly module: string) {}
}
