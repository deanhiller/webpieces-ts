import { FieldDef, SchemaShape, BaseRuleConfig, BASE_RULE_SCHEMA } from '@webpieces/rules-sdk';

import { StructuralMode, STRUCTURAL_MODES } from './rule-configs';

/**
 * The five rules that make an nx `framework:*` / `role:*` tag TRUE (#1064). Before them a tag was a
 * promise only the dependency graph checked; the code inside a library, the folder it lives in and the
 * packages it imports were never compared with it.
 *
 * Three are GRAPH rules (they read the whole nx project graph, so they run in `architecture:generate`
 * and `validate-architecture-unchanged` beside `library-types-match-client`): `api-lib-dependencies`,
 * `api-lib-path` and `framework-folder`. Two are PROJECT rules in `@webpieces/code-rules`:
 * `framework-tsconfig` and `framework-packages`.
 *
 * Every field that decides behaviour is REQUIRED with no default (`.claude/rules/no-rule-defaults.md`):
 * which packages an api library may import, which folders hold which runtimes, and which framework
 * packages belong to which runtime are the CONSUMER's layout, never webpieces'. The recommended values
 * are SEEDED into a fresh config (seed-entry.ts) and documented in `.claude/rules/framework-tags.md`.
 */

/**
 * The modes of the two PROJECT rules: OFF, MODIFIED_PROJECTS (every project owning a changed file) or
 * RUN_EVERY_TIME (every project in the repo — the migration sweep).
 */
export const PROJECT_SCAN_MODES = ['OFF', 'MODIFIED_PROJECTS', 'RUN_EVERY_TIME'] as const;
export type ProjectScanMode = typeof PROJECT_SCAN_MODES[number];

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

/**
 * `framework-tsconfig` (D7) — the COMPILER enforces the runtime a library's framework tags promise. Its
 * `tsconfig.lib.json` (with everything it `extends`) must resolve to:
 *  - every env a browser one (browser / angular / react): `lib` includes `dom`, `types` excludes `node`;
 *  - every env a node one (node / express): `lib` excludes `dom`, `types` includes `node`;
 *  - anything else (universal, browser + react-native, react-native): `lib` excludes `dom`, `types`
 *    excludes `node` — pure TypeScript.
 * An unset `lib` resolves to TypeScript's default, which includes `dom`; an unset `types` includes every
 * installed `@types/*`, so it counts as including `node`. Both must therefore be stated.
 *
 * - `mode` — OFF | MODIFIED_PROJECTS | RUN_EVERY_TIME.
 * - `allowedPaths` — optional globs over project roots this rule skips.
 */
export class FrameworkTsconfigConfig extends BaseRuleConfig {
    declare mode?: ProjectScanMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<FrameworkTsconfigConfig> = {
        mode: new FieldDef('string', PROJECT_SCAN_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

/** Framework packages and the runtimes that may import them. Data-only. */
export class FrameworkPackagesEntry {
    /** Package-name globs, e.g. `["@angular/*"]` or `["react", "react-native", "expo*"]`. Non-empty. */
    packages!: string[];
    /** The framework tags allowed to import them, e.g. `["angular"]`. Non-empty. */
    frameworks!: string[];

    static readonly SCHEMA: SchemaShape<FrameworkPackagesEntry> = {
        packages: FieldDef.nonEmptyStrings(),
        frameworks: FieldDef.nonEmptyStrings(),
    };
}

/**
 * `framework-packages` (D8) — a framework package is imported only by a project whose EVERY framework
 * tag is one its entry allows. A `browser+node` library importing `firebase-admin` is refused (its
 * browser env cannot run it); a `react` library importing `react` is not.
 *
 * Only production source is read (specs and test setup are not the runtime). A package no entry names
 * is not judged.
 *
 * - `mode` — OFF | MODIFIED_PROJECTS | RUN_EVERY_TIME.
 * - `entries` — required, non-empty. The recommended list is in `.claude/rules/framework-tags.md`.
 * - `allowedPaths` — optional globs over project roots this rule skips.
 */
export class FrameworkPackagesConfig extends BaseRuleConfig {
    declare mode?: ProjectScanMode;
    entries!: FrameworkPackagesEntry[];
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<FrameworkPackagesConfig> = {
        mode: new FieldDef('string', PROJECT_SCAN_MODES),
        entries: FieldDef.nonEmptyObjects(FrameworkPackagesEntry.SCHEMA),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
