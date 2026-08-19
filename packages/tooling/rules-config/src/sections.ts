// Which top-level section of webpieces.config.json a built-in belongs to.
//
//  - "rules"      — code-style validators (scope edit/file). They inspect file contents/diffs.
//  - "hookGuards" — git/PR/branch protection (scope bash). They intercept the shell command an
//                   agent is about to run (git/gh) rather than validate file contents.
//
// These are conceptually different and are installed differently (guards typically for the whole
// team, code rules often per-developer while iterating), so they live in separate config sections.
export type ConfigSection = 'rules' | 'hookGuards';

/**
 * The `hookGuards` CONFIG KEYS — ONE PER POLICY, not one per implementation class.
 *
 * Single source of truth for the rule/guard split, imported by the config validator (placement
 * checks), the loader (section merge), and the installer (config seeding).
 *
 * | key | the question it answers | classes behind it |
 * |---|---|---|
 * | `branch-state-guard`    | may I work here, and is what I read current? | feature-branch-guard, read-stale-guard, stale-main-bash-guard, merged-branch-bash-guard |
 * | `branch-creation-guard` | should this branch/worktree exist at all?    | branch-creation-guard |
 * | `pr-lifecycle-guard`    | do PRs and merges go through the gated flow? | pr-creation-or-push-guard, merge-in-progress-guard, pr-merge-guard, redirect-how-to-merge-main |
 *
 * A consumer turns a POLICY on or off; the class split is an implementation detail of tool wiring
 * (Read names one file, Bash is opaque, Write is neither). Nine keys let you configure half a policy —
 * `read-stale-guard: OFF` beside `merged-branch-bash-guard: ON` is "read the file, yes; `cat` the same
 * file, no" — and one key per policy makes that unrepresentable. The eight retired names are in
 * RETIRED_CONFIG_KEYS with the destination, all `prunable: false` so nothing deletes a configured guard.
 *
 * `branch-creation-guard` KEEPS its name. It is already one class and one policy carrying real
 * settings; renaming it to `branch-cleanup-guard` (which three docs once proposed) would cost a
 * retirement, a migration and prose churn for zero policy change.
 *
 * `whole-repo-build-guard` is NOT here: it has no webpieces.config.json entry at all (see
 * RETIRED_CONFIG_KEYS). It is ON by default for every tree, with a machine-local OPT-OUT in
 * ~/.webpieces/config.json, and ai-hook-rules runs it outside the config-driven rule set entirely.
 */
/**
 * The two POLICY keys shared by more than one class, as named constants.
 *
 * Every class behind them passes the constant as its `configKey`, so the wiring is a compile-time
 * reference rather than a repeated string literal that a rename could miss in one file out of four —
 * which is exactly how `applyCommandDefaults` used to break silently.
 */
export const BRANCH_STATE_GUARD_KEY = 'branch-state-guard';
export const PR_LIFECYCLE_GUARD_KEY = 'pr-lifecycle-guard';

export const HOOK_GUARD_NAMES: readonly string[] = [
    BRANCH_STATE_GUARD_KEY,
    'branch-creation-guard',
    PR_LIFECYCLE_GUARD_KEY,
];

const HOOK_GUARD_SET: ReadonlySet<string> = new Set(HOOK_GUARD_NAMES);

/**
 * Is this CONFIG KEY a hookGuard? Callers must pass `AbstractRule.configKey`, never `rule.name` — the
 * two diverge for every class behind a collapsed policy key, and passing a class name would classify
 * `feature-branch-guard` as a code-style rule and run it in the wrong hook.
 */
// webpieces-disable no-function-outside-class -- pure predicate over the module-scope key set beside it; it is imported by the validator, the loader and the installer alike, and a class here would be a namespace with no state
export function isHookGuard(configKey: string): boolean {
    return HOOK_GUARD_SET.has(configKey);
}

/** Which section `configKey`'s entry belongs in. Same contract as isHookGuard: keys, not class names. */
// webpieces-disable no-function-outside-class -- sibling of isHookGuard over the same module-scope key set
export function sectionForRule(configKey: string): ConfigSection {
    return HOOK_GUARD_SET.has(configKey) ? 'hookGuards' : 'rules';
}
