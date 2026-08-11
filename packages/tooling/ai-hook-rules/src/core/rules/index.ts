/**
 * Every built-in CONFIG KEY, i.e. every key that must have an entry under `rules` / `hookGuards`.
 *
 * This is the KEY set, not the CLASS set, and the distinction is the whole point of the collapse: the
 * four branch-state classes contribute the single key `branch-state-guard`, the four PR-lifecycle
 * classes the single key `pr-lifecycle-guard`. The loader iterates this array and asks
 * BUILT_IN_RULE_MAP for the rules each key builds, and the config-sync check (fault Y) compares a
 * loaded rule's `configKey` — never its `name` — against the keys present in the config.
 *
 * It used to be `builtInRuleNames`, one entry per class, which is the same list only because name and
 * key happened to coincide for every rule. Naming it for what it is stops that coincidence being
 * re-assumed: a rule NAME appearing here would be an entry every consumer is forced to configure for a
 * class that has no switch of its own.
 */
export const builtInConfigKeys: readonly string[] = [
    'no-any-unknown',
    'no-implicit-any',
    'max-file-lines',
    'validate-ts-in-src',
    'no-js-files',
    'no-destructure',
    'require-return-type',
    'no-unmanaged-exceptions',
    'catch-error-pattern',
    'throw-cause-required',
    'no-symbol-di-tokens',
    'no-custom-css',
    'no-process-exit-outside-main',
    'branch-creation-guard',
    'pr-lifecycle-guard',
    'branch-state-guard',
];
