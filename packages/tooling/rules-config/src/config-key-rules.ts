import { ConfigDocumentation, CONFIG_DOCUMENTATION_KEY, CONFIG_DOCUMENTATION_PATH } from './config-documentation';
import { isRetiredKey } from './retired-config-keys';

// Root config contains settings and one exact link to the generated instructions.
const TOP_LEVEL_KEYS: readonly string[] = [CONFIG_DOCUMENTATION_KEY, 'rulePacks', 'commands', 'excludePaths', 'match-rules'];

// webpieces-disable no-any-unknown -- the raw parsed config is opaque; only key names are read here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
// webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
export function validateTopLevelKeys(raw: Record<string, unknown>): string[] {
    const retired = ['rules', 'hookGuards', 'rulesDir', 'extends'].filter((key: string) =>
        Object.hasOwn(raw, key),
    );
    const errors = retired.map(
        (key: string) =>
            `[webpieces.config.json] Retired top-level key "${key}". ` +
            (key === 'rulesDir'
                ? 'Declare a client-owned rule pack with a schema and implementation module; directory scanning is retired.'
                : key === 'extends'
                  ? 'Declare exact rulePacks and explicit owner files; inherited central config is retired.'
                  : 'Move each entry it holds into the owner file its pack declares in rulePacks (.webpieces-config/rules/<pack>.json), then delete this key.'),
    );
    return [
        ...errors,
        ...new ConfigDocumentation().inlineErrors(raw, '[webpieces.config.json]'),
        ...(raw[CONFIG_DOCUMENTATION_KEY] === CONFIG_DOCUMENTATION_PATH ? [] : [
            `[webpieces.config.json] Require "${CONFIG_DOCUMENTATION_KEY}": "${CONFIG_DOCUMENTATION_PATH}". ` +
            `This exact generated guide documents the config; arbitrary paths are not accepted.`,
        ]),
        ...unknownKeyErrors(
            raw,
            [...TOP_LEVEL_KEYS, 'pr-gate', ...retired],
            '[webpieces.config.json]',
        ),
    ];
}

/**
 * Reject keys a section does not define. Without this a retired or misspelled key is simply ignored, which is
 * how a stale shape survives an upgrade forever — the whole failure mode RETIRED_CONFIG_KEYS exists to end.
 * Retired keys are skipped here so they get their own migration message instead of a generic "unknown key".
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON; only key names are read
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function unknownKeyErrors(
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    section: Record<string, unknown>,
    knownKeys: readonly string[],
    label: string,
): string[] {
    const errors: string[] = [];
    for (const key of Object.keys(section)) {
        if (knownKeys.includes(key) || isRetiredKey(key, label)) continue;
        if (key.endsWith('Why')) {
            errors.push(`${label} "${key}" is a retired inline documentation key. ` +
                `Remove it from JSON; keep repository-specific rationale in tracked Markdown. ` +
                `Config instructions: ${CONFIG_DOCUMENTATION_PATH}.`);
            continue;
        }
        errors.push(
            `${label} Unknown key "${key}". Valid keys: [${knownKeys.join(', ')}]. ` +
                `Delete it. Config instructions: ${CONFIG_DOCUMENTATION_PATH}.`,
        );
    }
    return errors;
}
