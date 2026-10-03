import { FieldDef, SchemaShape, BaseRuleConfig, BASE_RULE_SCHEMA } from "@webpieces/rules-sdk";
import { StructuralMode, STRUCTURAL_MODES } from "./rule-configs";
/** One `role:api-client` project and the outside packages it may import (its SDK, inversify, …). Data-only. */
export class ApiClientPackagesEntry {
    /** The nx project name of the `role:api-client` library, e.g. `gmail-client`. */
    project!: string;
    /** Package names (globs allowed, e.g. `@google-cloud/*`) it may import beyond `apiLibPackages`. */
    packages!: string[];

    static readonly SCHEMA: SchemaShape<ApiClientPackagesEntry> = {
        project: new FieldDef('string'),
        packages: new FieldDef('string[]'),
    };
}

/**
 * `api-lib-dependencies` (D2) — a `role:api-lib` may depend only on other `role:api-lib` projects plus
 * the outside packages in `apiLibPackages`; a `role:api-client` may ALSO import the packages its own
 * `apiClients` entry names (its SDK, `inversify`, `@webpieces/core-context`, …).
 *
 * - `mode` — OFF | RUN_EVERY_TIME (a graph rule: it reads every project, every run).
 * - `apiLibPackages` — required; may be empty (an api library then imports nothing from outside), e.g.
 *   `["@webpieces/core-util", "tslib"]`. A workspace project whose name or package name is listed here
 *   is allowed too, so a repo whose `core-util` is a workspace project states it the same way.
 * - `apiClients` — required; one entry per `role:api-client` project. A `role:api-client` with no
 *   entry is itself a violation: what it may talk to is stated, never inferred.
 */
export class ApiLibDependenciesConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    apiLibPackages!: string[];
    apiClients!: ApiClientPackagesEntry[];

    static readonly SCHEMA: SchemaShape<ApiLibDependenciesConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        apiLibPackages: new FieldDef('string[]'),
        apiClients: FieldDef.objects(ApiClientPackagesEntry.SCHEMA),
        ...BASE_RULE_SCHEMA,
    };
}

/**
 * `api-lib-path` (D10) — both directions: every `role:api-lib` / `role:api-client` project lives under
 * one of `paths`, and every project under `paths` carries one of those two roles.
 *
 * - `mode` — OFF | RUN_EVERY_TIME.
 * - `paths` — required, non-empty globs over project ROOTS, e.g. `["libraries/apis/**"]`.
 */
export class ApiLibPathConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    paths!: string[];

    static readonly SCHEMA: SchemaShape<ApiLibPathConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        paths: FieldDef.nonEmptyStrings(),
        ...BASE_RULE_SCHEMA,
    };
}

/**
 * One folder of the runtime layout: the project roots it covers, the framework SETS a project there may
 * carry, and the roles it may have. Data-only.
 *
 * A framework set is written as its tags joined by `+`, in any order: `"browser+node+react-native"`.
 * Listing two sets means EITHER — `["node", "express"]` is a node library or an express one.
 */
export class FrameworkFolderEntry {
    /** Globs over project ROOTS, e.g. `["libraries/universal/**"]`. Non-empty. */
    paths!: string[];
    /** The accepted framework sets, each `+`-joined, e.g. `["browser+node+react-native"]`. Non-empty. */
    frameworkSets!: string[];
    /** The accepted roles, e.g. `["lib", "designed-lib"]`. Non-empty. */
    roles!: string[];

    static readonly SCHEMA: SchemaShape<FrameworkFolderEntry> = {
        paths: FieldDef.nonEmptyStrings(),
        frameworkSets: FieldDef.nonEmptyStrings(),
        roles: FieldDef.nonEmptyStrings(),
    };
}

/**
 * `framework-folder` (D9) — the folder a library lives in and the tags it carries say the same thing,
 * both directions:
 *  - a project under an entry's `paths` (the FIRST entry whose glob matches, in `entries` order) must
 *    carry one of that entry's `frameworkSets`, exactly, and one of its `roles`;
 *  - a LIBRARY (any role but server/app/client/bundle) carrying a framework set and role that some entry
 *    lists must live under one of the entries that list them.
 *
 * - `mode` — OFF | RUN_EVERY_TIME.
 * - `entries` — required, non-empty. The recommended layout is in `.claude/rules/framework-tags.md`.
 */
export class FrameworkFolderConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    entries!: FrameworkFolderEntry[];

    static readonly SCHEMA: SchemaShape<FrameworkFolderConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        entries: FieldDef.nonEmptyObjects(FrameworkFolderEntry.SCHEMA),
        ...BASE_RULE_SCHEMA,
    };
}
