import { FieldDef, SchemaShape, BaseRuleConfig, BASE_RULE_SCHEMA } from "@webpieces/rules-sdk";
/**
 * The six rules that make an nx `framework:*` / `role:*` / `product:*` tag TRUE (#1064, #1179). Before
 * them a tag was a promise only the dependency graph checked; the code inside a library, the folder it
 * lives in and the packages it imports were never compared with it.
 *
 * Four are GRAPH rules (they read the whole nx project graph, so they run in `architecture:generate`
 * and `validate-architecture-unchanged` beside `library-types-match-client`): `api-lib-dependencies`,
 * `api-lib-path`, `framework-folder` and `product-tags` (every server, client and app names its
 * product), all owned by `@webpieces/nx-webpieces-rules`. Two are PROJECT rules in `@webpieces/code-rules`:
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
