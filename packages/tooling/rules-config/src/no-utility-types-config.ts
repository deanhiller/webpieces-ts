import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, ModifiedCodeMode, MODIFIED_CODE_MODES } from './rule-configs';

/**
 * `no-utility-types-in-api-lib` (#1026) — in every `.ts` file under `paths`, refuse the TypeScript
 * utility types that turn a contract's field list (or its set of keys) into a type-level computation:
 * `Omit`, `Pick`, `Partial`, `Required`, `Exclude` and `Extract`. Refused wherever a type is written
 * — `interface X extends Omit<…>`, a field type, a type alias, a generic argument.
 *
 * Why the whole family and not `Omit` alone: every one of them makes a reader open a second file and
 * compute the fields (or keys) in their head, none of them can become a DTO class (`class X extends
 * Omit<…>` does not compile — a utility type has no runtime value), and banning `Omit` alone just
 * moves the same computation into `Pick<T, Exclude<keyof T, K>>`. `Record`, `Readonly`, `Array` and
 * friends stay allowed: they do not hide which fields a DTO carries.
 *
 * Every field that decides behaviour is REQUIRED with no default (`.claude/rules/no-rule-defaults.md`):
 * - `mode` — OFF | NEW_AND_MODIFIED_CODE (only changed lines, so existing code is fixed as it is
 *   touched) | NEW_AND_MODIFIED_FILES (every occurrence in a changed file) | MODIFIED_PROJECTS /
 *   RUN_EVERY_TIME (every occurrence in a touched project / in the repo — #1027).
 * - `paths` — the globs of the API contract libraries this rule judges, e.g. `["libraries/apis/**"]`.
 *   An empty list judges nothing.
 *
 * `allowedPaths` exempts whole trees inside `paths`. The per-site escape hatch is
 * `// webpieces-disable no-utility-types-in-api-lib -- <reason>` on the line or the line above.
 */
export class NoUtilityTypesInApiLibConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    paths!: string[];
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoUtilityTypesInApiLibConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        paths: new FieldDef('string[]'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
