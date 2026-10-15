import { FieldDef } from './field-def';

/**
 * The fields EVERY rule carries. Apart from `mode` (whose enum is the rule's own), they are owned by
 * the FRAMEWORK, not by any rule (#1253):
 *
 *  - a pack schema does NOT declare them — RulePackRegistry merges {@link BASE_RULE_SCHEMA} into every
 *    owned rule's schema (forgetting to spread it used to drop the hatches silently);
 *  - a rule does NOT apply them — the dispatcher does: `AbstractRule.shouldRun()` for the skip check
 *    and `AbstractRule.excludesPath()` / the code-rules `RuleFileScope` for the path filter.
 *
 * So a rule added later gets every one of them with no code of its own.
 */
export abstract class BaseRuleConfig {
    // `mode` is declared here (loosely typed) so the shared AbstractRule base can read it for
    // on/off. Each concrete *Config narrows it to its own union (e.g. `mode?: ModifiedCodeMode`),
    // which is an assignable (covariant) override.
    mode?: string;
    // TS-optional, but schema-REQUIRED (see BASE_RULE_SCHEMA) — same split as `mode`. Read by
    // AbstractRule.shouldRun, which every dispatcher consults before a rule runs.
    turnOffRuleUntilEpoch?: number;
    turnOffRuleWhileOnBranch?: string | null;
    /**
     * Globs over the workspace-relative path (`**` any depth, `*` one segment): no file they match is
     * judged by THIS rule — in the build or in a hook. Optional; an absent list excludes nothing. The
     * top-level `excludePaths` of webpieces.config.json is the same filter for EVERY rule at once.
     */
    excludePaths?: string[];
    /** Optional free text recording WHY this entry is configured as it is (an exclusion, an off-switch). */
    reason?: string;
}

/** The framework-owned fields' schema. RulePackRegistry merges it; a pack schema never spreads it. */
export const BASE_RULE_SCHEMA = {
    turnOffRuleUntilEpoch: new FieldDef('number'),
    turnOffRuleWhileOnBranch: FieldDef.nullableString(),
    excludePaths: FieldDef.optional('string[]'),
    reason: FieldDef.optional('string'),
};

