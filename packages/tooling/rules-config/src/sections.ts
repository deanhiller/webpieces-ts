// Which top-level section of webpieces.config.json a built-in belongs to.
//
//  - "rules"      — code-style validators (scope edit/file). They inspect file contents/diffs.
//  - "hookGuards" — git/PR/branch protection (scope bash). They intercept the shell command an
//                   agent is about to run (git/gh) rather than validate file contents.
//
// These are conceptually different and are installed differently (guards typically for the whole
// team, code rules often per-developer while iterating), so they live in separate config sections.
export type ConfigSection = 'rules' | 'hookGuards';

// The bash-scope guards. Single source of truth for the rule/guard split, imported by the config
// validator (placement checks), the loader (section merge), and the installer (config seeding).
export const HOOK_GUARD_NAMES: readonly string[] = [
    'branch-creation-guard',
    'pr-creation-guard',
    'merge-in-progress-guard',
    'pr-merge-cleanup',
    'no-direct-main-update',
    'no-edit-on-main',
    'no-shell-substitution',
];

const HOOK_GUARD_SET: ReadonlySet<string> = new Set(HOOK_GUARD_NAMES);

export function isHookGuard(name: string): boolean {
    return HOOK_GUARD_SET.has(name);
}

export function sectionForRule(name: string): ConfigSection {
    return HOOK_GUARD_SET.has(name) ? 'hookGuards' : 'rules';
}
