import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, ModifiedCodeMode, MODIFIED_CODE_MODES } from './rule-configs';

/**
 * One `required-type-suffix` entry: the path globs it covers and the suffixes a type exported from a
 * file under them may end in. Data-only.
 */
export class RequiredTypeSuffixEntry {
    /** Workspace-relative globs, e.g. `["libraries/apis/internal/**"]`. Non-empty. */
    paths!: string[];
    /** Case-sensitive name suffixes, e.g. `["Request", "Response", "Event", "Dto", "Api"]`. Non-empty. */
    suffixes!: string[];

    static readonly SCHEMA: SchemaShape<RequiredTypeSuffixEntry> = {
        paths: FieldDef.nonEmptyStrings(),
        suffixes: FieldDef.nonEmptyStrings(),
    };
}

/**
 * `required-type-suffix` (#1037) — every EXPORTED `interface`, `class` (abstract too), `enum` and `type`
 * alias in a non-test `.ts` file under an entry's `paths` must end in one of that entry's `suffixes`
 * (plain, case-sensitive `endsWith`; the suffix alone is not a name). Why: the suffix tells a reader which
 * LAYER a type belongs to — a `…Dto` is on the wire, a `…Fs` is a Firestore document — where an
 * unsuffixed name reads the same as a server-internal or vendor type.
 *
 * Every field that decides behaviour is REQUIRED with no default (`.claude/rules/no-rule-defaults.md`):
 * - `mode` — OFF | NEW_AND_MODIFIED_CODE (only a type whose declaration line is new or changed — a new or
 *   renamed type — so legacy names are grandfathered) | NEW_AND_MODIFIED_FILES (every exported type in a
 *   changed file) | MODIFIED_PROJECTS / RUN_EVERY_TIME (every exported type in each touched project / the
 *   whole repo — #1027).
 * - `entries` — non-empty; each entry has non-empty `paths` and `suffixes`. For example:
 *
 *       "entries": [
 *         { "paths": ["libraries/apis/internal/**"], "suffixes": ["Request", "Response", "Event", "Dto", "Api"] },
 *         { "paths": ["libraries/browser-node/fs-*-model/**"], "suffixes": ["Fs"] }
 *       ]
 *
 * OVERLAP — the MOST SPECIFIC entry wins; suffixes are never unioned. A file is governed by exactly one
 * entry: among the entries with a glob matching the file, the one whose matching glob has the longest
 * LITERAL PREFIX (the characters before its first `*`, `?`, `[` or `{`) wins; a tie goes to the glob with
 * more literal characters overall, then to the entry listed FIRST. So `libraries/apis/internal/**` beats
 * `libraries/apis/**` for `libraries/apis/internal/x/src/A.ts`, whatever order they are listed in.
 *
 * `allowedPaths` exempts whole trees inside `paths`. The per-site escape hatch is
 * `// webpieces-disable required-type-suffix -- <reason>` on the declaration's line or the line above.
 */
export class RequiredTypeSuffixConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    entries!: RequiredTypeSuffixEntry[];
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<RequiredTypeSuffixConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        entries: FieldDef.nonEmptyObjects(RequiredTypeSuffixEntry.SCHEMA),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
