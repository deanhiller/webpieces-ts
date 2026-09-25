import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, ModifiedCodeMode, MODIFIED_CODE_MODES } from './rule-configs';

/**
 * `no-inline-import-in-api-lib` (#1023) — in every `role:api-lib` project, refuse an `import('…')`
 * TYPE node (`activeAiProvider?: import('@myorg/company-core').AiProvider`) and a dynamic `import()`
 * EXPRESSION. An API imports at the top of the file, only: an inline import hides a cross-library
 * dependency from every reader of the contract and from the tools that read its imports.
 *
 * `mode` is REQUIRED and has no default (`.claude/rules/no-rule-defaults.md`): OFF |
 * NEW_AND_MODIFIED_CODE (only changed lines — grandfathers the rest) | NEW_AND_MODIFIED_FILES (every
 * occurrence in a changed file) | MODIFIED_PROJECTS / RUN_EVERY_TIME (every occurrence in a touched
 * project / in the repo — #1027; count what is left with `wp-validate-code --rule=… --mode=RUN_EVERY_TIME`). `allowedPaths` exempts whole trees. The per-site escape hatch is
 * `// webpieces-disable no-inline-import-in-api-lib -- <reason>` on the line or the line above.
 */
export class NoInlineImportInApiLibConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoInlineImportInApiLibConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

/**
 * `one-enum-spelling-in-api-lib` (#1023) — in every `role:api-lib` project, a fixed set of string
 * values has ONE spelling: a string `enum` whose every member is explicitly initialised with a string
 * literal (`export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }`), used as the enum, one
 * member of it, or a union of its members. Refused, each with a cure that prints the enum to write:
 * a string-literal union of two or more members (in a type alias, a field or a parameter),
 * `(typeof X)[number]`, `keyof typeof X`, a single string-literal type used as a union discriminator,
 * and a numeric, heterogeneous, `const` or non-initialised enum (a numeric enum puts numbers on the
 * wire).
 *
 * The GENERATOR keeps supporting string-literal unions — for other consumers, and for code this rule's
 * mode grandfathers. This rule is what forbids NEW ones in an api library.
 *
 * `mode` is REQUIRED and has no default (`.claude/rules/no-rule-defaults.md`), with the same three
 * values as above; `allowedPaths` and the per-site disable work the same way.
 */
export class OneEnumSpellingInApiLibConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<OneEnumSpellingInApiLibConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
