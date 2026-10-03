import { BaseRuleConfig, BASE_RULE_SCHEMA } from "@webpieces/rules-sdk";
import { FieldDef, SchemaShape } from "@webpieces/rules-sdk";
// Structural / whole-graph rules (import-cycle, runtime-architecture, nx-wiring). They can't be
// scoped to changed lines/files — a cycle or wiring break can route through a project that wasn't
// itself edited — so when active they run the FULL check every time (nx-affected already limits
// them to affected projects externally). RUN_EVERY_TIME replaces the old, vaguer "ON".
export const STRUCTURAL_MODES = ['OFF', 'RUN_EVERY_TIME'] as const;

export type StructuralMode = typeof STRUCTURAL_MODES[number];

// NOTE: there is deliberately no `WholeRepoBuildGuardConfig`. That guard has NO webpieces.config.json
// entry — it is EXPERIMENTAL and OFF by default, and its only switch is the OPT-IN
// `experimental.whole-repo-build-guard: true` in the optional machine-local ~/.webpieces/config.json
// (see home-config.ts). The build command it prints
// is handed to it directly from `commands.pr-gate.buildCommand` by ai-hook-rules' runner. Re-adding a
// config class here puts the guard back in RULE_SCHEMAS and makes it a fault-Y rule again.

export class NoFileImportCyclesConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    ignoreTypeOnly?: boolean;
    excludePackages?: string[];
    // Raw regex escape hatch for a cycle inside the project being checked — generated code, a
    // vendored tree, or a deliberate bidirectional domain model — that `excludePackages` cannot reach
    // (it resolves npm package NAMES, so it only excludes a *sibling* package, never a directory
    // inside this one). Patterns are handed to madge verbatim and matched against ids RELATIVE TO THE
    // PROJECT (e.g. "^src/generated/", "^src/modules/(item|category)/") — NOT workspace-rooted or
    // absolute, which silently match nothing. The executor warns when a pattern matches zero
    // traversed files, so a mis-anchored pattern is visible rather than a silent no-op.
    excludeRegExp?: string[];

    static readonly SCHEMA: SchemaShape<NoFileImportCyclesConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ignoreTypeOnly: FieldDef.optional('boolean'),
        excludePackages: FieldDef.optional('string[]'),
        excludeRegExp: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class RuntimeArchitectureConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    // NOTE: `servicePaths` / `apiProjectPaths` were removed — they were never read. The runtime graph
    // is derived SOLELY from architecture/dependencies.json apiRelations + project roles (see
    // nx-webpieces-rules/src/lib/runtime-graph.ts), so any config still listing them (a hand-maintained
    // enumeration of api libs) now fails the unknown-field check in validateWebpiecesConfig. There is
    // nothing to enumerate — delete the keys.
    // NOTE: `allowedCycles` was removed — a runtime cycle is no longer allowable at all. CD deploys
    // services in dependency order and a cyclic architecture has no such order, so the runtime graph
    // now THROWS while it is being levelled rather than emitting a flat, unlevellable diagram (see
    // nx-webpieces-rules/src/lib/runtime-graph-levels.ts). A repo that genuinely cannot break a cycle
    // yet declares it PER EDGE with a `cutLegacyCycle:<targetService>` nx tag on the CALLING project,
    // which admits the debt in a place `grep -rn cutLegacyCycle` can enumerate. Delete the key.
    /**
     * Draw a dashed terminal node for every contract a service calls that NOTHING in-repo
     * implements (firestore, gmail, ...) — the vendor systems the runtime graph otherwise stops one
     * hop short of. Defaults to true; set false in a repo whose external surface is noisy. Purely a
     * RENDER switch: levels, cycle detection and runtime-dependencies.json are identical either way.
     */
    showExternalNodes?: boolean;
    /**
     * Project roots whose exported `*Api` types are contracts for systems OUTSIDE this repo
     * (firestore, gmail, gcp-storage, ...), e.g. `["libraries/apis/external/**"]`. Globs, matched
     * against the nx project root.
     *
     * Needed because an external contract does NOT look like an in-repo one: it is a plain
     * `interface` bound to a Symbol token and injected, never an `abstract class` carrying @ApiPath
     * reached through `createRpcClient`. Without this list the scanner has no way to tell a vendor
     * seam from any other library, so every call leaving the repo is invisible to the runtime graph.
     *
     * Defaults to none, which is correct for a repo with no vendor wrapper libraries.
     */
    externalApiPaths?: string[];

    static readonly SCHEMA: SchemaShape<RuntimeArchitectureConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        showExternalNodes: FieldDef.optional('boolean'),
        externalApiPaths: FieldDef.optional('string[]'),
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

export class MissingDesignAnnotationConfig extends BaseRuleConfig {
    // Structural: enforced per-project by the di-graph-generate executor, which
    // roots the whole DI design on @DocumentDesign classes — cannot be line-scoped.
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<MissingDesignAnnotationConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

// ---------------------------------------------------------------------------
// The five Nx infrastructure validators (architecture-unchanged, no-architecture-cycles,
// packagejson, versions-locked, eslint-sync). Each is whole-graph / whole-repo by nature (a cycle, a
// drifted dependencies.json, an unlocked version can be introduced by a file nobody in this diff
// touched), so the only honest mode set is STRUCTURAL_MODES: RUN_EVERY_TIME (the default) or OFF.
//
// All five now honor the universal escape hatches (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch)
// via shouldSkipRule — the RuleGate is called with honorEpoch:true from
// every executor. This lets a repo time-box or branch-scope a failing infrastructure check (e.g. hold
// validate-packagejson off until an upgrade PR lands) with a one-value edit, instead of only the
// blunt "mode": "OFF". Originally packagejson/versions-locked/eslint-sync were all-or-nothing on the
// theory that "no blessed baseline" made grandfathering meaningless, but a time-box is a schedule, not
// a baseline: "do not enforce this until <epoch>/off <branch>" is coherent for any rule.
// ---------------------------------------------------------------------------

export class ValidateArchitectureUnchangedConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<ValidateArchitectureUnchangedConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidateNoArchitectureCyclesConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<ValidateNoArchitectureCyclesConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidatePackageJsonConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<ValidatePackageJsonConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidateVersionsLockedConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<ValidateVersionsLockedConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidateEslintSyncConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;

    static readonly SCHEMA: SchemaShape<ValidateEslintSyncConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        ...BASE_RULE_SCHEMA,
    };
}
