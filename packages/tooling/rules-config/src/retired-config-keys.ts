/**
 * Retired webpieces.config.json keys — the ONE place in the codebase where a dead config key may be named.
 *
 * ## THE POLICY: webpieces.config.json is never released backwards-compatible
 *
 * When a config key moves, is renamed, or is deleted, the loader REJECTS the old shape with an error that
 * names the destination. It does NOT quietly accept both. There is no fallback, no alias table applied
 * before validation, no "still accepted for back-compat until every consumer migrates".
 *
 * This is safe *here* in a way it is not for a normal library, and the reason is the consumer: every reader
 * of this file is a coding agent. The config is validated on startup, the agent is handed the exact edit,
 * and it applies it in one pass — so the upgrade is seamless without shipping a compatibility layer. That
 * makes a hard failure strictly cheaper than duality: two accepted shapes means two code paths, two sets of
 * defaults and two sets of error messages to keep honest forever, and the stale shape then lives in
 * consumer configs indefinitely because nothing ever forces the edit.
 *
 * A hard rejection here is always self-recoverable, which is what makes it safe to do:
 *   - editing webpieces.config.json is ALWAYS permitted, even while the config is invalid (see the banner
 *     in config-file.ts and the guard matrix — a Write/Edit targeting this file is an unconditional PASS),
 *   - `pnpm install` is ALWAYS permitted (installer bypass), which fixes the far more common cause of a
 *     validation failure: an installed validator lagging the config by a release.
 * So rejecting an old shape can never wedge a repo. "It would deadlock the consumer" is not a reason to add
 * a fallback; it is not true.
 *
 * ## Adding an entry
 *
 * When you retire a key, add it here and DELETE its read path — do not leave a `??` fallback behind. The
 * `instruction` is the whole product: it is read by an agent that will act on it verbatim, so give the
 * mechanical edit ("rename X to Y", "move A into B"), not a description of the change. Saying where a thing
 * moved to is exactly the point of this table; it is what makes the fallback unnecessary.
 *
 * retired-config-keys.spec.ts asserts every entry below actually FAILS the load. That spec is the guard: a
 * future fallback that silently swallows a retired key turns it red.
 */

import { RETIRED_KEY_MARKER } from './config-error-banner';

// A retired key is matched one of two ways, because config keys live at two very different levels.
// RULE — a rule/guard NAME, which may sit under either `rules` or `hookGuards`, so it is matched by bare
//        name rather than by a fixed path.
// KEY  — a plain key inside a known section, matched by name within that section.
export const RETIRED_SCOPE_RULE = 'rule';
export const RETIRED_SCOPE_KEY = 'key';

/** One retired config key and the mechanical edit that replaces it. Data-only (per CLAUDE.md). */
export class RetiredConfigKey {
    scope: string;
    // The key exactly as it appears in webpieces.config.json.
    key: string;
    // Where the value goes now. Empty string when the key is deleted outright with no replacement.
    movedTo: string;
    // The imperative fix, written for the agent that will apply it.
    instruction: string;
    // Bracketed label leading the error, matching the `[rule-name]` / `[section]` convention in this package.
    label: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(scope: string, key: string, movedTo: string, instruction: string, label: string) {
        this.scope = scope;
        this.key = key;
        this.movedTo = movedTo;
        this.instruction = instruction;
        this.label = label;
    }
}

/**
 * Every retired key. Keep the newest at the bottom with the release that retired it, so the list reads as a
 * changelog an agent can walk when a config is several versions behind.
 */
export const RETIRED_CONFIG_KEYS: readonly RetiredConfigKey[] = [
    // --- Guard renames. Previously applied SILENTLY before validation (a DEPRECATED_RULE_ALIASES table in
    // load-config.ts rewrote the key so no validator ever saw it). That hid the rename from the config file
    // forever: the old name kept working, so no consumer ever updated, and the alias table could never be
    // deleted. Now each is a hard error with the new name.
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'pr-merge-cleanup', 'pr-merge-guard',
        'Rename the key to "pr-merge-guard". Its value carries over unchanged.',
        '[pr-merge-cleanup]',
    ),
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'pr-creation-guard', 'pr-creation-or-push-guard',
        'Rename the key to "pr-creation-or-push-guard" — the guard grew a second blocked action (a manual ' +
        'git push), so it is no longer only about PR creation. Its value carries over unchanged.',
        '[pr-creation-guard]',
    ),
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'main-stale-guard', 'read-stale-guard',
        'Rename the key to "read-stale-guard" — the guard grew a second blocked state (an already-merged ' +
        'feature branch), so it is no longer about `main` at all; it is THE guard that can block a Read. ' +
        'Its value carries over unchanged.',
        '[main-stale-guard]',
    ),

    // --- The two flat guard-hint strings, superseded by commands.guardHints so that every guard-facing
    // command string sits in one named sub-object instead of loose beside the gate config.
    new RetiredConfigKey(
        RETIRED_SCOPE_KEY, 'upsertPr', 'commands.guardHints.prCreationOrPush',
        'Move the value to "guardHints": { "prCreationOrPush": <value> } inside the same "commands" ' +
        'section, then delete "upsertPr".',
        '[commands]',
    ),
    new RetiredConfigKey(
        RETIRED_SCOPE_KEY, 'mergeComplete', 'commands.guardHints.mergeInProgress',
        'Move the value to "guardHints": { "mergeInProgress": <value> } inside the same "commands" ' +
        'section, then delete "mergeComplete".',
        '[commands]',
    ),

    // --- The two-list excludePaths object. The split never earned its keep (every consumer set both lists
    // to the same value), and the one case that would need them to differ is served better by a rule's own
    // `excludePaths`. Retired as a SHAPE: `rules` is the entry validateExcludePaths reports for either key.
    new RetiredConfigKey(
        RETIRED_SCOPE_KEY, 'rules', 'excludePaths (one flat array)',
        'Replace the whole { "rules": [...], "guards": [...] } object with ONE array holding the union of ' +
        'both lists, de-duplicated — e.g. "excludePaths": ["repositories/**"]. A path is governed by ' +
        'webpieces or it is not, so there is no longer a per-engine split. To exclude a path from one rule ' +
        'only, use that rule\'s own "excludePaths" inside its config block instead.',
        '[excludePaths]',
    ),
];

/**
 * The shared message. Leads with the retirement, then the destination, then the edit — an agent reading this
 * should not have to infer anything.
 *
 * RETIRED_KEY_MARKER is the phrase the banner classifier keys off to call this error DEFINITIVE (no
 * install can revive a key this table names), so the marker is IMPORTED rather than re-typed here.
 */
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this package
export function retiredKeyError(entry: RetiredConfigKey): string {
    const destination = entry.movedTo === ''
        ? 'It was removed with no replacement.'
        : `It moved to "${entry.movedTo}".`;
    return `${entry.label} "${entry.key}" ${RETIRED_KEY_MARKER}. ${destination} ${entry.instruction}`;
}

/**
 * The retired entry for a rule/guard NAME, or null. Callers must consult this BEFORE reporting a name as an
 * unknown rule: the unknown-rule message leads with "run `pnpm install`, your validator may be stale", which
 * is exactly the wrong advice for a name we know is dead.
 */
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this package
export function retiredRuleFor(ruleName: string): RetiredConfigKey | null {
    return RETIRED_CONFIG_KEYS.find(e => e.scope === RETIRED_SCOPE_RULE && e.key === ruleName) ?? null;
}

/**
 * Whether `key` is retired within `label`'s section. Unknown-key rejection consults this so a retired key
 * gets its migration message instead of a generic "unknown key, delete it" — the migration instruction is
 * the entire reason this table exists.
 */
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this package
export function isRetiredKey(key: string, label: string): boolean {
    return RETIRED_CONFIG_KEYS.some(e => e.scope === RETIRED_SCOPE_KEY && e.label === label && e.key === key);
}

/**
 * The retired entry for `key` within `label`'s section. For a retirement that is a SHAPE rather than a
 * single key (the excludePaths object), the validator looks the entry up directly so one table row remains
 * the single source of the message.
 */
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this package
export function retiredEntry(key: string, label: string): RetiredConfigKey | null {
    return RETIRED_CONFIG_KEYS.find(e => e.scope === RETIRED_SCOPE_KEY && e.label === label && e.key === key) ?? null;
}

/** Errors for every retired plain key present in `section`. `label` scopes the lookup to that section. */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON; only key PRESENCE is read
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this package
export function retiredKeyErrorsIn(section: Record<string, unknown>, label: string): string[] {
    return RETIRED_CONFIG_KEYS
        .filter(e => e.scope === RETIRED_SCOPE_KEY && e.label === label && e.key in section)
        .map(e => retiredKeyError(e));
}
