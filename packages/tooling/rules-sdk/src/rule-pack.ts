import { FieldDef } from './field-def';

/** Versioned independently from npm releases: incompatible contracts require an explicit bump. */
export const RULE_PACK_API_VERSION = 3;
export const RULE_SCHEMA_API_VERSION = 1;
export type ExecutionKind = 'build' | 'source-hook' | 'workflow-guard' | 'lint';
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigObject;
export class ConfigObject {
    [key: string]: ConfigValue;
}

/** Owner-authored catalog guidance; {configFile} is replaced by the client's exact declaration. */
export class RuleHelp {
    constructor(
        readonly description: string,
        readonly remediation: string,
    ) {}
}

/** The single owner supplies the configuration schema, regardless of implementation count. */
export class OwnedRuleDefinition {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly id: string,
        readonly schema: Readonly<Record<string, FieldDef>>,
        readonly schemaApiVersion: number,
        readonly optionalTuning: ConfigObject,
        readonly recommendedSeed: ConfigObject,
        readonly section: RuleConfigSection,
        readonly help: RuleHelp,
    ) {}
}

/** Each pack may implement an owned rule or contribute an execution kind to another owner. */
export class RuleContribution {
    constructor(
        readonly ruleId: string,
        readonly ownerPack: string,
        readonly executionKind: ExecutionKind,
        readonly implementationModule: string,
    ) {}
}

export class RulePackManifest {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly packageName: string,
        readonly packageVersion: string,
        readonly apiVersion: number,
        readonly ownedRules: readonly OwnedRuleDefinition[],
        readonly contributions: readonly RuleContribution[],
        readonly migrations: readonly RetiredConfigKey[],
        readonly safeguards: readonly SafeguardDefinition[],
    ) {}
}

/** Explicit module declarations let a client add packs without a central built-in package list. */
export class RulePackDeclaration {
    constructor(readonly module: string) {}
}

export type RuleConfigSection = 'rules' | 'hookGuards' | 'lint';

/** A fixed invariant has no config switch; experimental safeguards require a separate explicit opt-in. */
export class SafeguardDefinition {
    constructor(
        readonly id: string,
        readonly activation: 'fixed' | 'experimental',
        readonly description: string,
    ) {}
}

/** Owner-provided migration instructions are data; the framework rejects rather than aliases retired keys. */
export class RetiredConfigKey {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly scope: string,
        readonly key: string,
        readonly movedTo: string,
        readonly instruction: string,
        readonly label: string,
        readonly prunable: boolean,
    ) {}
}
