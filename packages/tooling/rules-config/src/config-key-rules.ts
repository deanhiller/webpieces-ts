import { isRetiredKey } from './retired-config-keys';

// Key-level rules every webpieces.config.json section shares: strict unknown-key rejection and the `*Why`
// comment convention. Its own module because both validate-config.ts (top level) and
// commands-section-validators.ts (the commands section) need it, and either importing the other would
// close an import cycle.

/**
 * Every key webpieces.config.json defines at the TOP level. `pr-gate` is deliberately absent — it is the
 * retired top-level block, and validateCommandsSection already reports it with the move instruction, so
 * listing it here would replace that precise message with a generic "unknown key".
 */
const TOP_LEVEL_KEYS: readonly string[] = [
    'extends', 'rules', 'hookGuards', 'commands', 'excludePaths', 'match-rules', 'rulesDir',
];

/**
 * Reject unknown TOP-LEVEL keys. Without this, a key that was retired at the top level (or simply
 * misspelled) is silently ignored — the config looks configured and behaves as if it were not, and the dead
 * key survives every upgrade. `*Why` rationale keys are allowed, which is what lets the file document
 * itself: this repo ships a top-level `upgradePolicyWhy` stating that config is validated on startup and
 * migrated by the agent, so no backwards-compatible release is needed.
 */
// webpieces-disable no-any-unknown -- the raw parsed config is opaque; only key names are read here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validateTopLevelKeys(raw: Record<string, unknown>): string[] {
    return unknownKeyErrors(raw, [...TOP_LEVEL_KEYS, 'pr-gate'], '[webpieces.config.json]');
}

/**
 * The `*Why` convention: any key ending in "Why" is free-form rationale a consumer keeps beside the key it
 * explains. JSON has no comments, so this is how this repo documents non-obvious config — and it is the only
 * way the config file can carry the note that matters most to the agent reading it (see the top-level
 * "upgradePolicyWhy" this repo ships). Comment keys are therefore allowed wherever unknown keys are
 * otherwise rejected, and must be strings.
 *
 * ONE exception, enforced separately: `gateSaltWhy` is rejected outright, because rationale next to the gate
 * salt is a bypass how-to in the most-read file in the repo. See validateNoGateSaltRationale.
 */
export const COMMENT_KEY_SUFFIX = 'Why';

// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function isCommentKey(key: string): boolean {
    return key.length > COMMENT_KEY_SUFFIX.length && key.endsWith(COMMENT_KEY_SUFFIX);
}

/**
 * Reject keys a section does not define. Without this a retired or misspelled key is simply ignored, which is
 * how a stale shape survives an upgrade forever — the whole failure mode RETIRED_CONFIG_KEYS exists to end.
 * Retired keys are skipped here so they get their own migration message instead of a generic "unknown key".
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON; only key names are read
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function unknownKeyErrors(section: Record<string, unknown>, knownKeys: readonly string[], label: string): string[] {
    const errors: string[] = [];
    for (const key of Object.keys(section)) {
        if (knownKeys.includes(key) || isRetiredKey(key, label)) continue;
        if (isCommentKey(key)) {
            if (typeof section[key] !== 'string') {
                errors.push(`${label} "${key}" is a *Why rationale note and must be a string.`);
            }
            continue;
        }
        errors.push(
            `${label} Unknown key "${key}". Valid keys: [${knownKeys.join(', ')}]. ` +
            `Delete it, or — if it is rationale you want to keep beside a key — rename it to "<key>Why" ` +
            `with a string value (JSON has no comments, so "*Why" siblings are how this repo documents config).`,
        );
    }
    return errors;
}


