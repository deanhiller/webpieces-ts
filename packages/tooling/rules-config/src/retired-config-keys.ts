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
 *   - and `PRUNE_UNKNOWN_COMMAND` is an L0 CURE, so the mechanical cleanup of keys no validator knows runs
 *     from inside the block too.
 * So rejecting an old shape can never wedge a repo. "It would deadlock the consumer" is not a reason to add
 * a fallback; it is not true.
 *
 * NOT `pnpm install`. This paragraph used to offer it as the escape hatch that "fixes the far more common
 * cause of a validation failure: an installed validator lagging the config by a release". It is permitted
 * (installer bypass), but it is not the cure for anything you can read here: the shim's version-drift guard
 * compares the pin against the installed version and denies every tool call BEFORE the validator runs, so a
 * validation error on screen is proof that package.json and node_modules already agree. The banner from this
 * same package now says "Do NOT run `pnpm install` — it cannot help", and a docstring teaching the opposite
 * is how that advice leaked back out.
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
import { PRUNE_UNKNOWN_COMMAND } from './constants';

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
    /**
     * True when DELETING the key from webpieces.config.json is the entire edit — nothing in THIS file
     * replaces it, so `PRUNE_UNKNOWN_COMMAND` may strip it mechanically. `whole-repo-build-guard` is the
     * worked example: its switch moved OUT of the repo config into `~/.webpieces/config.json`, so the
     * value has nowhere to go here.
     *
     * False for a rename or an in-file move: deleting those would DISCARD a value the reader still needs,
     * so they keep their migration instruction and the pruner leaves them alone. Required, not defaulted —
     * a defaulted `false` would let a future deletion-only retirement silently opt out of the mechanical
     * cure and land back in "the reader decides while every Bash call is blocked".
     */
    prunable: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(scope: string, key: string, movedTo: string, instruction: string, label: string, prunable: boolean) {
        this.scope = scope;
        this.key = key;
        this.movedTo = movedTo;
        this.instruction = instruction;
        this.label = label;
        this.prunable = prunable;
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
    //
    // These three RE-POINTED when hookGuards collapsed to one key per policy. Their old destinations
    // (`pr-merge-guard`, `pr-creation-or-push-guard`, `read-stale-guard`) are themselves retired now,
    // and a retirement whose `movedTo` names a dead key teaches the removed API — the same defect one
    // level out. Each therefore names the POLICY key it lands on today, in one hop.
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'pr-merge-cleanup', 'pr-lifecycle-guard',
        'Rename the key to "pr-lifecycle-guard" (merging its value into that entry if you already have ' +
        'one — the four PR/merge guards share one key now). Its mode and escape hatches carry over.',
        '[pr-merge-cleanup]', false,
    ),
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'pr-creation-guard', 'pr-lifecycle-guard',
        'Rename the key to "pr-lifecycle-guard" (merging its value into that entry if you already have ' +
        'one — the four PR/merge guards share one key now). Its mode and escape hatches carry over; the ' +
        'old "upsertPrCommand" field does NOT — that string lives only in commands.guardHints.prCreationOrPush.',
        '[pr-creation-guard]', false,
    ),
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'main-stale-guard', 'branch-state-guard',
        'Rename the key to "branch-state-guard" (merging its value into that entry if you already have ' +
        'one — the four branch-state guards share one key now). Its mode and escape hatches carry over. ' +
        'Note the widened scope: that key arms the Write, Read AND Bash halves of the branch-state ' +
        'policy, not just the Read block this key used to name.',
        '[main-stale-guard]', false,
    ),

    // --- The two flat guard-hint strings, superseded by commands.guardHints so that every guard-facing
    // command string sits in one named sub-object instead of loose beside the gate config.
    new RetiredConfigKey(
        RETIRED_SCOPE_KEY, 'upsertPr', 'commands.guardHints.prCreationOrPush',
        'Move the value to "guardHints": { "prCreationOrPush": <value> } inside the same "commands" ' +
        'section, then delete "upsertPr".',
        '[commands]', false,
    ),
    new RetiredConfigKey(
        RETIRED_SCOPE_KEY, 'mergeComplete', 'commands.guardHints.mergeInProgress',
        'Move the value to "guardHints": { "mergeInProgress": <value> } inside the same "commands" ' +
        'section, then delete "mergeComplete".',
        '[commands]', false,
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
        '[excludePaths]', false,
    ),

    // --- whole-repo-build-guard, retired as a REPO-CONFIG key one release after it was added. It shipped
    // as a conventional validated guard (mode ON by default, entry REQUIRED under hookGuards), so every
    // consumer that upgraded hit fault Y — every Bash call blocked — for a feature nobody had opted into.
    // The REQUIRED KEY was the fault, not the default: the failure was at config LOAD, before any command
    // was judged. The switch now lives ONLY in the optional machine-local ~/.webpieces/config.json, where
    // nothing has to be added to be in the default state — and the default is OFF, as every experimental
    // flag's is, so deleting this entry loses nothing.
    new RetiredConfigKey(
        RETIRED_SCOPE_RULE, 'whole-repo-build-guard', '~/.webpieces/config.json → experimental.whole-repo-build-guard',
        'DELETE this entry from webpieces.config.json — no repo config key controls this guard any more. ' +
        'The guard is OFF by default for everyone, with no file and no key required. To turn it ON for ' +
        'YOUR machine only, put {"experimental": {"whole-repo-build-guard": true}} in ' +
        '~/.webpieces/config.json — that file is optional and is tracked by no repo.',
        '[whole-repo-build-guard]', true,
    ),

    // --- THE 9 → 3 COLLAPSE of `hookGuards`: one key per POLICY, not one per implementation CLASS.
    //
    // Eight class-named keys become two policy keys. The CLASSES are untouched — `feature-branch-guard`
    // is still the rule name in every decision-log line and every deny report — so nothing an operator
    // greps for moved. What moved is the SWITCH, because nine keys let a consumer configure HALF a
    // policy: `read-stale-guard: OFF` beside `merged-branch-bash-guard: ON` is "read the file, yes;
    // `cat` the same file, no", which nobody chose and the config made reachable.
    //
    // EVERY ONE OF THESE IS `prunable: false`, and that is not bookkeeping. `PRUNABLE_SECTIONS` in
    // ConfigPruner includes `hookGuards`, and the validation banner actively RECOMMENDS running the
    // pruner. A `prunable: true` here would mean the recommended cure silently DELETES four configured
    // guards with no destination named — a config loss, which is worse than a block. False keeps the
    // migration instruction and makes the pruner return null for these keys.
    //
    // 4 → 1 is legal for this table (nothing requires `movedTo` to be unique), but it is NOT legal for
    // a naive 1:1 migrator: see migrateRetiredRuleNames in ai-hook-rules' setup.ts, which unions the
    // four old entries into the destination and then fills any missing required field, rather than
    // renaming the first and deleting the rest.
    ...branchStateRetirements(),
    ...prLifecycleRetirements(),
];

// The four branch-state classes. Split into a helper purely to keep the table above readable; the
// instruction is per-key because the fields that carry over differ (only feature-branch-guard had
// `branchNamingConvention`).
// webpieces-disable no-function-outside-class -- table data for RETIRED_CONFIG_KEYS, beside the array it feeds
function branchStateRetirements(): RetiredConfigKey[] {
    const merged = 'MERGE it into ONE "branch-state-guard" entry under "hookGuards"';
    const shared =
        `${merged}. All four of feature-branch-guard, read-stale-guard, stale-main-bash-guard and ` +
        'merged-branch-bash-guard now read that single entry — they are one policy ("may I work here, ' +
        'and is what I read current?") implemented by four classes, and configuring them separately let ' +
        'you switch on half of it. Keep "mode", "turnOffRuleUntilEpoch" and "turnOffRuleWhileOnBranch"; ' +
        'the ONE "hangTimeoutMinutes" survives (there was only ever one refresher and one cache, so at ' +
        'most one of the four values could ever take effect); "branchNamingConvention" survives from ' +
        'feature-branch-guard. If the four disagreed on "mode", pick the one you meant — "ON" arms the ' +
        'whole policy including the Read block. Then DELETE this key.';
    return [
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'feature-branch-guard', 'branch-state-guard', shared, '[feature-branch-guard]', false),
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'read-stale-guard', 'branch-state-guard', shared, '[read-stale-guard]', false),
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'stale-main-bash-guard', 'branch-state-guard', shared, '[stale-main-bash-guard]', false),
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'merged-branch-bash-guard', 'branch-state-guard', shared, '[merged-branch-bash-guard]', false),
    ];
}

// The four PR-lifecycle classes.
// webpieces-disable no-function-outside-class -- table data for RETIRED_CONFIG_KEYS, beside the array it feeds
function prLifecycleRetirements(): RetiredConfigKey[] {
    const shared =
        'MERGE it into ONE "pr-lifecycle-guard" entry under "hookGuards". All four of ' +
        'pr-creation-or-push-guard, merge-in-progress-guard, pr-merge-guard and ' +
        'redirect-how-to-merge-main now read that single entry — they are one policy ("do PRs and ' +
        'merges go through the gated flow?"). Keep "mode", "turnOffRuleUntilEpoch" and ' +
        '"turnOffRuleWhileOnBranch". Know what "mode": "OFF" now means: it releases the ' +
        'unvalidated-merge gate as well as the PR/push blocks, because merge-in-progress-guard is under ' +
        'this key too. The per-guard "upsertPrCommand" / "mergeCompleteCommand" fields are gone — those ' +
        'strings live ONLY in commands.guardHints.prCreationOrPush / .mergeInProgress. Then DELETE this key.';
    return [
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'pr-creation-or-push-guard', 'pr-lifecycle-guard', shared, '[pr-creation-or-push-guard]', false),
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'merge-in-progress-guard', 'pr-lifecycle-guard', shared, '[merge-in-progress-guard]', false),
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'pr-merge-guard', 'pr-lifecycle-guard', shared, '[pr-merge-guard]', false),
        new RetiredConfigKey(RETIRED_SCOPE_RULE, 'redirect-how-to-merge-main', 'pr-lifecycle-guard', shared, '[redirect-how-to-merge-main]', false),
    ];
}

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
    // Deletion-only retirements get the mechanical cure named right here, so the reader never has to
    // decide whether removing a key is safe while the guard is denying every Bash call.
    const mechanical = entry.prunable
        ? ` Deleting it is the WHOLE fix — \`${PRUNE_UNKNOWN_COMMAND}\` does it for you.`
        : '';
    return `${entry.label} "${entry.key}" ${RETIRED_KEY_MARKER}. ${destination} ${entry.instruction}${mechanical}`;
}

/**
 * The retired entry for a rule/guard NAME, or null. Callers must consult this BEFORE reporting a name as an
 * unknown rule: the generic unknown-rule message can only say "delete it", while this table knows WHERE the
 * setting went — a rename that must carry its value over, or a move to `~/.webpieces/config.json`. The
 * destination is the whole product, and a bare "delete it" would throw it away.
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
