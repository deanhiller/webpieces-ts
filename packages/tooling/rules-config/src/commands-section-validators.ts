import { RETIRED_TOP_LEVEL_MARKER } from './config-error-banner';
import { unknownKeyErrors } from './config-key-rules';
import { retiredKeyErrorsIn } from './retired-config-keys';
import { validatePrGateSection } from './validate-config';

// The `commands` section of webpieces.config.json, plus the key-level rules every section shares: strict
// unknown-key rejection and the `*Why` comment convention. Split out of validate-config.ts only for size,
// exactly as pr-gate-section-validators.ts was; loadAndValidate still reaches this through
// validateCommandsSection, which validate-config.ts re-exports.

// Every key the `commands` section defines. Anything else is rejected — see unknownKeyErrors for why a
// tolerated unknown key is the mechanism by which a stale config shape survives upgrades forever.
const COMMANDS_KEYS: readonly string[] = ['pr-gate', 'guardHints'];
const GUARD_HINT_FIELDS: readonly string[] = ['prCreationOrPush', 'mergeInProgress'];

/**
 * Validate the `commands` section: its `pr-gate` block (delegated to validatePrGateSection), the
 * `guardHints` command strings, and strict rejection of everything else. Also surfaces a migration error if
 * a DEPRECATED top-level `pr-gate` block is still present, telling the consumer to move it under `commands`.
 *
 * There is deliberately no fallback from `commands["pr-gate"]` to the top-level block: the top-level block
 * is a hard error above, so a config carrying it never loads, and a fallback for a shape that cannot load is
 * dead code that only makes the real shape ambiguous. See retired-config-keys.ts for the policy.
 */
// webpieces-disable no-any-unknown -- `commands`/`legacyPrGate` are opaque consumer JSON
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validateCommandsSection(commands: unknown, legacyPrGate: unknown, repoRoot?: string): string[] {
    const errors: string[] = [];

    if (legacyPrGate !== undefined) {
        errors.push(
            // RETIRED_TOP_LEVEL_MARKER is imported, not re-typed: it is what the banner classifier keys off
            // to call this DEFINITIVE (a shape no version of the validator accepts).
            `[pr-gate] The top-level "pr-gate" ${RETIRED_TOP_LEVEL_MARKER}. Move it under the "commands" ` +
            `section as commands["pr-gate"] (run \`pnpm wp-install-ai-hooks --sync\` to migrate automatically).`,
        );
    }

    if (commands !== undefined && (typeof commands !== 'object' || commands === null || Array.isArray(commands))) {
        errors.push(`[commands] Must be an object { "pr-gate": {...}, "guardHints": {...} }.`);
        return errors;
    }

    // webpieces-disable no-any-unknown -- narrowing the opaque commands section from consumer JSON
    const c = (commands ?? {}) as Record<string, unknown>;

    errors.push(...retiredKeyErrorsIn(c, '[commands]'));
    errors.push(...unknownKeyErrors(c, COMMANDS_KEYS, '[commands]'));

    // pr-gate is required (set mode OFF to opt out).
    errors.push(...validatePrGateSection(c['pr-gate'], repoRoot));
    errors.push(...validateGuardHints(c['guardHints']));

    return errors;
}

/**
 * The `commands.guardHints` sub-object: the command strings the bash guards print in their fix hints. Each
 * name binds to exactly one guard, so an unknown field here is a hint nothing will ever read.
 */
// webpieces-disable no-any-unknown -- `hints` is opaque consumer JSON until narrowed here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function validateGuardHints(hints: unknown): string[] {
    if (hints === undefined) return [];
    if (typeof hints !== 'object' || hints === null || Array.isArray(hints)) {
        return [`[commands] "guardHints" must be an object { "prCreationOrPush": "...", "mergeInProgress": "..." }.`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque guardHints object from consumer JSON
    const h = hints as Record<string, unknown>;
    const errors: string[] = unknownKeyErrors(h, GUARD_HINT_FIELDS, '[commands.guardHints]');
    for (const field of GUARD_HINT_FIELDS) {
        if (field in h && (typeof h[field] !== 'string' || (h[field] as string).trim() === '')) {
            errors.push(`[commands] "guardHints.${field}" must be a non-empty string (the gated command to run).`);
        }
    }
    return errors;
}
