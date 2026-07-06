import { FieldDef, SchemaShape } from './field-def';

// Mode const arrays — TypeScript union types derived from them, and FieldDef enum
// values reference the same array. Impossible for the type and runtime check to diverge.

// Single source of truth for rule "mode" values. Exported so code-rules (and any other
// consumer) imports these instead of re-declaring the same unions — a rename here ripples
// everywhere at compile time. The FieldDef SCHEMA below references the same arrays, so the
// type and the runtime validation can never diverge.
export const METHOD_LIMIT_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;
export type MethodLimitMode = typeof METHOD_LIMIT_MODES[number];

export const FILE_LIMIT_MODES = ['OFF', 'NEW_AND_MODIFIED_FILES'] as const;
export type FileLimitMode = typeof FILE_LIMIT_MODES[number];

export const RETURN_TYPE_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;
export type ReturnTypeMode = typeof RETURN_TYPE_MODES[number];

export const INLINE_TYPE_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;
export type InlineTypeMode = typeof INLINE_TYPE_MODES[number];

export const MODIFIED_CODE_MODES = ['OFF', 'NEW_AND_MODIFIED_CODE', 'NEW_AND_MODIFIED_FILES'] as const;
export type ModifiedCodeMode = typeof MODIFIED_CODE_MODES[number];

// PROJECT-level rules (e.g. framework-tag): the check is neither line- nor file-scoped — it runs
// for a whole project when ANY file the project owns is touched. `MODIFIED_PROJECTS` names that
// honestly (nx `affected` already narrows execution to the changed projects).
export const PROJECT_MODES = ['OFF', 'MODIFIED_PROJECTS'] as const;
export type ProjectMode = typeof PROJECT_MODES[number];

export const PRISMA_DTOS_MODES = ['OFF', 'MODIFIED_CLASS', 'NEW_AND_MODIFIED_FILES'] as const;
export type PrismaValidateDtosMode = typeof PRISMA_DTOS_MODES[number];

export const PRISMA_CONVERTER_MODES = ['OFF', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;
export type PrismaConverterMode = typeof PRISMA_CONVERTER_MODES[number];

export const DIRECT_API_RESOLVER_MODES = ['OFF', 'NEW_AND_MODIFIED_CODE', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;
export type DirectApiResolverMode = typeof DIRECT_API_RESOLVER_MODES[number];

export const THROW_CAUSE_MODES = ['OFF', 'NEW_AND_MODIFIED_CODE'] as const;
export type ThrowCauseMode = typeof THROW_CAUSE_MODES[number];

export const ON_OFF_MODES = ['ON', 'OFF'] as const;
export type OnOffMode = typeof ON_OFF_MODES[number];

// branch-creation-guard modes. ON_NO_SUBBRANCHES is the strict variant: it hard-blocks
// creating a branch off any non-main branch (no sub-branch affordance), pointing the agent
// back to `git checkout main && git pull && git checkout -b <branch>`. Temporarily overridable
// via the universal ignoreModifiedUntilEpoch escape hatch.
export const BRANCH_GUARD_MODES = ['ON', 'OFF', 'ON_NO_SUBBRANCHES'] as const;
export type BranchGuardMode = typeof BRANCH_GUARD_MODES[number];

export const VALIDATE_TS_MODES = ['OFF', 'NEW_AND_MODIFIED_FILES'] as const;
export type ValidateTsMode = typeof VALIDATE_TS_MODES[number];

// Structural / whole-graph rules (import-cycle, runtime-architecture, nx-wiring). They can't be
// scoped to changed lines/files — a cycle or wiring break can route through a project that wasn't
// itself edited — so when active they run the FULL check every time (nx-affected already limits
// them to affected projects externally). RUN_EVERY_TIME replaces the old, vaguer "ON".
export const STRUCTURAL_MODES = ['OFF', 'RUN_EVERY_TIME'] as const;
export type StructuralMode = typeof STRUCTURAL_MODES[number];

// ---------------------------------------------------------------------------
// Universal escape hatches — EVERY rule supports temporarily disabling itself
// either while on a named git branch (ignoreRuleWhileOnBranch) or until an
// epoch passes (ignoreModifiedUntilEpoch). They live on a shared base class so
// the two fields (and their schema entries) are declared once instead of
// repeated per rule. `mode` stays per-rule because its allowed values vary
// (ON/OFF vs NEW_AND_MODIFIED_CODE vs NEW_AND_MODIFIED_METHODS, etc).
//
// `ignoreModifiedUntilEpoch` is REQUIRED on every rule so the time-box escape
// hatch is always present and a rule can be turned off with a one-value edit.
// Convention: 0 = rule active (epoch is in the past, never skipped); a future
// unix epoch IN SECONDS = rule temporarily disabled until that moment.
// `ignoreRuleWhileOnBranch` stays optional.
// ---------------------------------------------------------------------------
export abstract class BaseRuleConfig {
    // `mode` is declared here (loosely typed) so the shared AbstractRule base can read it for
    // on/off. Each concrete *Config narrows it to its own union (e.g. `mode?: ModifiedCodeMode`),
    // which is an assignable (covariant) override.
    mode?: string;
    // TS-optional, but schema-REQUIRED (see BASE_RULE_SCHEMA) — same split as `mode`.
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
}

export const BASE_RULE_SCHEMA = {
    ignoreModifiedUntilEpoch: new FieldDef('number'),
    ignoreRuleWhileOnBranch: FieldDef.optional('string'),
};

export class MaxMethodLinesConfig extends BaseRuleConfig {
    declare mode?: MethodLimitMode;
    limit?: number;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<MaxMethodLinesConfig> = {
        mode: new FieldDef('string', METHOD_LIMIT_MODES),
        limit: FieldDef.optional('number'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class MaxFileLinesConfig extends BaseRuleConfig {
    declare mode?: FileLimitMode;
    limit?: number;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<MaxFileLinesConfig> = {
        mode: new FieldDef('string', FILE_LIMIT_MODES),
        limit: FieldDef.optional('number'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class RequireReturnTypeConfig extends BaseRuleConfig {
    declare mode?: ReturnTypeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<RequireReturnTypeConfig> = {
        mode: new FieldDef('string', RETURN_TYPE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoInlineTypeLiteralsConfig extends BaseRuleConfig {
    declare mode?: InlineTypeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoInlineTypeLiteralsConfig> = {
        mode: new FieldDef('string', INLINE_TYPE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoAnyUnknownConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoAnyUnknownConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoImplicitAnyConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoImplicitAnyConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrismaValidateDtosConfig extends BaseRuleConfig {
    declare mode?: PrismaValidateDtosMode;
    disableAllowed?: boolean;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];

    static readonly SCHEMA: SchemaShape<PrismaValidateDtosConfig> = {
        mode: new FieldDef('string', PRISMA_DTOS_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        prismaSchemaPath: FieldDef.optional('string'),
        dtoSourcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrismaConverterConfig extends BaseRuleConfig {
    declare mode?: PrismaConverterMode;
    disableAllowed?: boolean;
    schemaPath?: string;
    convertersPaths?: string[];
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<PrismaConverterConfig> = {
        mode: new FieldDef('string', PRISMA_CONVERTER_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        schemaPath: FieldDef.optional('string'),
        convertersPaths: FieldDef.optional('string[]'),
        enforcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoDestructureConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    allowTopLevel?: boolean;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoDestructureConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowTopLevel: FieldDef.optional('boolean'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoUnmanagedExceptionsConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoUnmanagedExceptionsConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class CatchErrorPatternConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<CatchErrorPatternConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class ThrowCauseRequiredConfig extends BaseRuleConfig {
    declare mode?: ThrowCauseMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<ThrowCauseRequiredConfig> = {
        mode: new FieldDef('string', THROW_CAUSE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class AngularNoDirectApiInResolverConfig extends BaseRuleConfig {
    declare mode?: DirectApiResolverMode;
    disableAllowed?: boolean;
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<AngularNoDirectApiInResolverConfig> = {
        mode: new FieldDef('string', DIRECT_API_RESOLVER_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        enforcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoSymbolDiTokensConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoSymbolDiTokensConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// enforce-controller-naming — a controller class (one decorated @Controller() OR whose heritage
// ends in `*Api`) must be named `{Something}Controller` AND live in a lower-case kebab file
// `{something}-controller.ts`. The kebab file name is the contract a separate controller-discovery
// tool relies on (it globs `**/*-controller.ts`). `allowedPaths` exempts legit non-controller
// `*Api` implementers (e.g. a `*Simulator` under `**/remote/**`).
export class EnforceControllerNamingConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<EnforceControllerNamingConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// framework-tag — every project that a changed source file belongs to must carry >=1
// `framework:<browser|react|angular|node|express>` nx tag in its project.json. Those tags are the
// project's "libType" — the SET of runtime environments it runs in — and the source of truth for
// the dependencies.json `framework` field and the `library-types-match-client` rule. Multiple tags
// are allowed (the env set) and values are validated against the known set (`framework:all` is a
// hard error). `knownTypes` customizes that set (defaults to browser, react, angular, node, express).
export class FrameworkTagConfig extends BaseRuleConfig {
    declare mode?: ProjectMode;
    knownTypes?: string[];

    static readonly SCHEMA: SchemaShape<FrameworkTagConfig> = {
        mode: new FieldDef('string', PROJECT_MODES),
        knownTypes: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// role-tag — every project that a changed source file belongs to must carry a
// `role:<server|designed-lib|lib|client>` nx tag in its project.json. That tag is the project's
// ROLE (orthogonal to `framework` libType) — the source of truth for the dependencies.json `role`
// field, the `role-dependency` edge rule (apps are never depended upon), and DI-design generation
// (server→@Controller, designed-lib→@ApiImplementation, lib→none, client→angular design).
// `knownTypes` customizes the list suggested to the author when a tag is missing.
export class RoleTagConfig extends BaseRuleConfig {
    declare mode?: ProjectMode;
    knownTypes?: string[];

    static readonly SCHEMA: SchemaShape<RoleTagConfig> = {
        mode: new FieldDef('string', PROJECT_MODES),
        knownTypes: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class BranchCreationGuardConfig extends BaseRuleConfig {
    declare mode?: BranchGuardMode;
    // Naming pattern for stacked SUB-branches only (branches created off another feature branch,
    // which require human approval). Never applied to branches created off main.
    subBranchNaming?: string;
    // Human-sentence instruction telling the AI how to name a NEW branch off main. Surfaced back
    // to the agent in the guard's fix hints. May mirror no-edit-on-main.branchNamingConvention.
    branchFormat?: string;

    static readonly SCHEMA: SchemaShape<BranchCreationGuardConfig> = {
        mode: new FieldDef('string', BRANCH_GUARD_MODES),
        subBranchNaming: FieldDef.optional('string'),
        branchFormat: FieldDef.optional('string'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrCreationOrPushGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    // The gated command the guard points agents to instead of direct PR creation OR a manual push.
    // Per-project override; defaults to `pnpm wp-start-upsert-pr` at the point of use.
    upsertPrCommand?: string;

    static readonly SCHEMA: SchemaShape<PrCreationOrPushGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        upsertPrCommand: FieldDef.optional('string'),
        ...BASE_RULE_SCHEMA,
    };
}

export class MergeInProgressGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    // The gated command the guard points agents to in order to finish a 3-point merge. Per-project
    // override; defaults to `commands.mergeComplete` (pnpm wp-git-merge-complete) at load time.
    mergeCompleteCommand?: string;

    static readonly SCHEMA: SchemaShape<MergeInProgressGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        mergeCompleteCommand: FieldDef.optional('string'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrMergeGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<PrMergeGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class RedirectHowToMergeMainConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<RedirectHowToMergeMainConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

// Comprehensive "are you on a proper feature branch?" guard. Replaces the old no-edit-on-main:
//  - on main (synchronous check)                  → block, create a feature branch
//  - branch already merged into main (merged PR)  → block, branch off fresh main
//  - no fork point with origin/main               → block, squash onto a new branch
//  - origin/main moved & touches your files       → block, merge main first
// branchNamingConvention is surfaced in the on-main message; hangTimeoutMinutes tunes the detached
// refresher's stale-lock reclaim window.
export class FeatureBranchGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    branchNamingConvention?: string;
    hangTimeoutMinutes?: number;

    static readonly SCHEMA: SchemaShape<FeatureBranchGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        branchNamingConvention: FieldDef.optional('string'),
        hangTimeoutMinutes: FieldDef.optional('number'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoFileImportCyclesConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    ignoreTypeOnly?: boolean;
    excludePackages?: string[];

    static readonly SCHEMA: SchemaShape<NoFileImportCyclesConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ignoreTypeOnly: FieldDef.optional('boolean'),
        excludePackages: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class RuntimeArchitectureConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    servicePaths?: string[];
    apiProjectPaths?: string[];
    allowedCycles?: string[];

    static readonly SCHEMA: SchemaShape<RuntimeArchitectureConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        servicePaths: FieldDef.optional('string[]'),
        apiProjectPaths: FieldDef.optional('string[]'),
        allowedCycles: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NxWiringConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<NxWiringConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class DiGraphConfig extends BaseRuleConfig {
    // Structural: the DI graph is regenerated whole-project on every build (generate +
    // unchanged gate), so it cannot be scoped to changed lines.
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<DiGraphConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoJsFilesConfig extends BaseRuleConfig {
    // File-tier: NEW_AND_MODIFIED_FILES (active) intercepts a .js/.jsx Write — the file being
    // written is inherently a new/modified file, so it's already diff-scoped in practice.
    declare mode?: FileLimitMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoJsFilesConfig> = {
        mode: new FieldDef('string', FILE_LIMIT_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidateTsInSrcConfig extends BaseRuleConfig {
    declare mode?: ValidateTsMode;
    allowedRootFiles?: string[];
    excludePaths?: string[];

    static readonly SCHEMA: SchemaShape<ValidateTsInSrcConfig> = {
        mode: new FieldDef('string', VALIDATE_TS_MODES),
        allowedRootFiles: FieldDef.optional('string[]'),
        excludePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
