import { PolicyFieldConstraints } from './policy-field-constraints';
export { MAX_TURN_OFF_EPOCH_DAYS } from './policy-field-constraints';
import { FieldDef, RetiredConfigKey } from '@webpieces/rules-sdk';
import * as fs from 'fs';
import * as path from 'path';

import { RulePackRegistry } from './rule-pack-registry';
import { allRuleNames } from './rule-schemas';
import { recommendedSeedModeFor, isGradualMode } from './seed-entry';
import { MODIFIED_CODE_MODES } from '@webpieces/rules-sdk';
import {
    validateChecklistsSection,
    validateDevDeploySection,
    validateLandPrSection,
    validateNoGateSaltRationale,
    validateReviewerAgentKeys,
} from './pr-gate-section-validators';
import { retiredEntry, retiredKeyError, retiredRuleFor } from './retired-config-keys';
import { PRUNE_UNKNOWN_COMMAND } from './constants';

// Re-exported so the isolated validate-checklist-docs target keeps importing it from here.
export { validateChecklistsSection };
// Re-exported from their new homes: this module was the historical entry point for both.
export { allRuleNames } from './rule-schemas';
export { recommendedSeedMode, recommendedSeedModeFor, seedEntryForRule } from './seed-entry';
import { DEFAULT_MATCH_RULES } from './match-rules-config';
import { toError } from '@webpieces/tooling-common/to-error';

/**
 * The longest a `turnOffRuleUntilEpoch` may reach into the future: ONE WEEK. Poke it again next week to
 * extend — that weekly re-set IS the intended workflow, not a workaround: it is what makes a rule that is
 * off on purpose stay a decision somebody keeps making, instead of one nobody remembers.
 *
 * DELIBERATELY ASYMMETRIC with turnOffRuleWhileOnBranch, which has NO cap and must not get one. The epoch
 * hatch is REPO-WIDE while it lasts, so a long window shelters every unrelated change that lands inside it
 * (a fleet repo was found with max-file-lines/max-method-lines switched off until 2026-10-01 — 43 days
 * out, six times this cap). The branch hatch fires only on ONE exact branch name — a big refactor
 * legitimately runs 35+ days, and capping that would only interrupt the one branch that opted in.
 */

/**
 * Reject a `turnOffRuleUntilEpoch` more than MAX_TURN_OFF_EPOCH_DAYS into the future.
 *
 * A PAST epoch is always valid: it is inert (it skips nothing), and every existing config is full of them.
 * The BOUNDARY is inclusive — exactly MAX_TURN_OFF_EPOCH_DAYS out is accepted, only strictly beyond it is
 * refused — so a config written as "now + 7 days" is never rejected by the second it took to save.
 */
// webpieces-disable no-function-outside-class -- module-scope validator helper, matching every other check in this file
function epochCapError(label: string, value: number): string | null {
    return new PolicyFieldConstraints().epochError(label, value);
}

function valueHint(def: FieldDef, key?: string): string {
    // The two universal escape hatches, REQUIRED on every rule so they're always visible. Spell out the
    // "off" value so a fresh config seeds them in the active/no-op state (0 / null), not a placeholder.
    if (key === 'turnOffRuleUntilEpoch')
        return '0  (0 = active; future unix-epoch seconds = temporarily off)';
    if (key === 'turnOffRuleWhileOnBranch')
        return 'null  (null = always on; an EXACT branch name — no globs — disables the rule while that branch is checked out)';
    return def.enumValues
        ? `"${def.enumValues.join(' | ')}"`
        : def.type === 'string[]'
          ? '["<string>", ...]'
          : def.type === 'object[]'
            ? objectListHint(def)
            : def.type === 'number'
              ? '<number>'
              : def.type === 'boolean'
                ? '<boolean>'
                : '"<string>"';
}

/** `[{ "paths": ["<string>", ...], "suffixes": ["<string>", ...] }, ...]` — one element spelled out from its schema. */
// webpieces-disable no-function-outside-class -- module-scope sibling of valueHint
function objectListHint(def: FieldDef): string {
    const schema: Readonly<Record<string, FieldDef>> = def.elementSchema ?? {};
    const fields = Object.keys(schema)
        .filter((key: string) => !schema[key].optional)
        .map((key: string) => `"${key}": ${valueHint(schema[key], key)}`);
    return `[{ ${fields.join(', ')} }, ...]`;
}

/**
 * A config key whose schema is absent from every explicitly selected owner manifest. THE FALLBACK: it fires for any name the table in retired-config-keys.ts does not
 * know, which very much includes RETIRED names on a tree whose validator predates the retirement — the
 * ordinary linked-worktree layout, where the worktree is on one release and the parent checkout that
 * supplies the hook's resolution is on an older one. So this text has to be useful with NO table entry.
 *
 * DELETION LEADS, and it is not a hedge. A key the running validator has no schema for controls nothing:
 * every code path that would read it is keyed off the schema. Leaving it is dead config that reads as live
 * config, and for a retired key deleting it is the entire fix.
 *
 * This message used to lead with `pnpm install` instead, on the theory that the key might be valid and the
 * validator merely stale. Two things are wrong with that. First, it CONTRADICTED the banner this error is
 * printed inside, which states outright that `pnpm install` cannot help — one output, two opposite orders.
 * Second, the premise is already handled upstream: the shim's version-drift guard compares the pin against
 * the installed version and denies every tool call BEFORE exec'ing this validator, with its own message and
 * its own cure. If this text is on screen, that guard found no drift. The pin therefore appears here only as
 * a secondary note, so a valid-but-newer key is never dropped without the reader being told the case exists.
 */
function unknownRuleError(ruleName: string): string {
    return (
        `[${ruleName}] Unknown rule — the running @webpieces validator has no selected owner schema for it. A key no validator knows controls NOTHING, so ` +
        `DELETE the "${ruleName}" key from the direct policy-ID map in its declared owner config file. ` +
        `Run \`${PRUNE_UNKNOWN_COMMAND}\` to remove unknown entries from declared owner files mechanically. ` +
        `It may be RETIRED: a newer release can move ` +
        `a setting out of this file entirely, in which case deleting the key here is the WHOLE fix. ` +
        `MACHINE-LOCAL settings in particular now live in ~/.webpieces/config.json under "experimental" — ` +
        `an optional file tracked by no repo, whose absence is the default behaviour — so if ` +
        `"${ruleName}" is one of those, delete it here and set it there. Secondary, and rare: a key is ` +
        `valid-but-unlearned when package.json pins an @webpieces OLDER than this config was written for, ` +
        `and the version-drift guard reports THAT separately with its own cure (bump the pin) before this ` +
        `validator ever runs — so it is not what you are looking at.`
    );
}

/** Schema advice names the selected owner rather than a retired root section. */
class RuleConfigAdvice {
    constructor(private readonly registry: RulePackRegistry) {}

    private rolloutTip(schema: Readonly<Record<string, FieldDef>>): string {
        const modes = schema['mode']?.enumValues ?? [];
        // Same source of truth as the seeder; only a GRADUAL recommendation gets the rollout prose, so a
        // rule whose recommendation falls through to ON/RUN_EVERY_TIME/OFF prints no tip (as before).
        const recommended = recommendedSeedModeFor(modes);
        if (!isGradualMode(recommended)) return '';
        const optOut = modes.includes('OFF') ? ' Set "mode": "OFF" to opt out entirely.' : '';
        return (
            `\n\n💡 Recommended: start with "mode": "${recommended}" — it enforces only on what you ` +
            `actually change, so the rule rolls out gradually (existing code stays grandfathered until ` +
            `you next touch that project/file/method).${optOut}`
        );
    }

    missingRuleSnippet(ruleName: string, schema: Readonly<Record<string, FieldDef>>): string {
        // Required fields go in the copy-paste entry. The two universal escape hatches
        // (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch) are now REQUIRED, so they land in that block —
        // which is the whole point: every seeded rule shows both hatches. Optional fields are listed separately.
        const fields = Object.keys(schema);
        const required = fields.filter((f: string) => !schema[f].optional);
        const optional = fields.filter((f: string) => schema[f].optional);

        const requiredLines = required.map((f: string) => `    "${f}": ${valueHint(schema[f], f)}`);
        const owner = this.registry.ownerOf(ruleName);
        let out =
            `[${ruleName}] Not configured in the declared owner config file for ${owner}. ` +
            `Add this entry directly to that file's policy-ID map\n` +
            `(choose values appropriate for your project):\n\n` +
            `  "${ruleName}": {\n${requiredLines.join(',\n')}\n  }`;

        if (optional.length > 0) {
            const optionalLines = optional.map(
                (f: string) => `    "${f}": ${valueHint(schema[f], f)}`,
            );
            out +=
                `\n\nOptional fields you may add to this rule (omit if not needed):\n` +
                `${optionalLines.join(',\n')}`;
        }
        out += this.rolloutTip(schema);
        return out;
    }
}

// Fields we DELETED from a rule's schema, keyed by "<rule>.<field>". The generic unknown-field error
// ("Unknown field ... Valid fields: [...]") is correct but doesn't say WHY the field vanished, so an AI
// might re-add it. These hints explain the removal so the only action left is to delete the key.

// Universal field renames (apply to EVERY rule/guard AND every match-rule, unlike the per-rule
// RETIRED_FIELD_HINTS). When an entry still uses the old escape-hatch name, the generic unknown-field
// error is replaced with a precise "renamed to X — rename it" instruction so the fix is mechanical.


// The renamed-field message shared by keyed rules and match-rules.
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function renamedFieldError(scope: string, oldKey: string, newKey: string): string {
    return `${scope} Unknown field "${oldKey}" — it was renamed to "${newKey}". Rename it (the value carries over unchanged; for the branch hatch, use null when there is no branch).`;
}

/**
 * Field-level errors for ONE configured rule entry: unknown/renamed/retired keys, type and enum
 * mismatches, and the two-week cap on turnOffRuleUntilEpoch.
 *
 * Extracted out of validateWebpiecesConfig purely so that function stays inside max-method-lines; it is
 * the same checks in the same order.
 */
// webpieces-disable no-any-unknown -- one config entry as opaque JSON; every field is typed-checked below
// webpieces-disable no-function-outside-class -- module-scope validator helper, matching every other check in this file
function fieldErrors(
    ruleName: string,
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    entry: Record<string, unknown>,
    schema: Readonly<Record<string, FieldDef>>,
    registry: RulePackRegistry,
): string[] {
    const errors: string[] = [];
    for (const [key, value] of Object.entries(entry)) {
        const fieldDef = schema[key];
        if (!fieldDef) {
            const renamedTo = new PolicyFieldConstraints().renamedField(key);
            if (renamedTo) {
                errors.push(renamedFieldError(`[${ruleName}]`, key, renamedTo));
                continue;
            }
            const retiredHint = registry
                .migrations()
                .find(
                    (entry: RetiredConfigKey) =>
                        entry.scope === 'field' && entry.key === `${ruleName}.${key}`,
                )?.instruction;
            const suffix = retiredHint ? ` ${retiredHint}` : '';
            errors.push(
                `[${ruleName}] Unknown field "${key}". Valid fields: [${Object.keys(schema).join(', ')}].${suffix}`,
            );
            continue;
        }
        // A nullable field (e.g. turnOffRuleWhileOnBranch) accepts JSON null in addition to its type.
        if (value === null && fieldDef.nullable) continue;
        if (fieldDef.type === 'string[]' || fieldDef.type === 'object[]') {
            errors.push(...arrayFieldErrors(`[${ruleName}] "${key}"`, value, fieldDef));
        } else if (typeof value !== fieldDef.type) {
            errors.push(`[${ruleName}] "${key}" must be ${fieldDef.type}, got ${typeof value}.`);
        } else if (fieldDef.enumValues && !fieldDef.enumValues.includes(value as string)) {
            errors.push(
                `[${ruleName}] "${key}" = "${value}" is not valid. Must be one of: ${fieldDef.enumValues.join(', ')}.`,
            );
        } else if (key === 'turnOffRuleUntilEpoch') {
            const capError = epochCapError(`[${ruleName}]`, value as number);
            if (capError) errors.push(capError);
        } else if (
            ruleName === 'branch-state-guard' &&
            key === 'maxCommitsBehind' &&
            (!Number.isInteger(value) || (value as number) < 0)
        ) {
            errors.push('[branch-state-guard] "maxCommitsBehind" must be a non-negative integer.');
        }
    }
    return errors;
}

/**
 * Errors for one array-typed field (`string[]` / `object[]`): the element type, `nonEmpty`, and — for
 * `object[]` — every element against the field's `elementSchema` (unknown keys, missing required keys,
 * and each element field checked recursively). `label` is `[rule] "field"`, extended per element
 * (`[rule] "entries"[0].suffixes`) so an error names the exact spot to edit.
 */
// webpieces-disable no-any-unknown -- a config field value is opaque JSON until this checks its shape
// webpieces-disable no-function-outside-class -- module-scope validator helper, matching every other check in this file
// webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
function arrayFieldErrors(label: string, value: unknown, def: FieldDef): string[] {
    const isObjects = def.type === 'object[]';
    // webpieces-disable no-any-unknown -- one list element as opaque JSON; this line is what checks its shape
    const elementOk = (v: unknown): boolean =>
        isObjects
            ? typeof v === 'object' && v !== null && !Array.isArray(v)
            : typeof v === 'string';
    if (!Array.isArray(value) || !value.every(elementOk)) {
        const shape = isObjects ? 'a list of objects' : 'string[]';
        return [
            `${label} must be ${shape}, got ${Array.isArray(value) ? 'a list holding something else' : typeof value}.`,
        ];
    }
    if (def.nonEmpty && value.length === 0) {
        return [
            `${label} must not be empty — an empty list judges nothing while reading as configured. Add ${valueHint(def)}.`,
        ];
    }
    if (!isObjects || def.elementSchema === undefined) return [];
    const errors: string[] = [];
    const schema = def.elementSchema;
    // webpieces-disable no-any-unknown -- an element's fields are opaque JSON until checked against its schema below
    value.forEach((element: Record<string, unknown>, index: number) => {
        const at = `${label}[${index}]`;
        for (const key of Object.keys(element)) {
            if (!(key in schema))
                errors.push(
                    `${at} Unknown field "${key}". Valid fields: [${Object.keys(schema).join(', ')}].`,
                );
        }
        for (const [key, fieldDef] of Object.entries(schema)) {
            if (!(key in element)) {
                if (!fieldDef.optional)
                    errors.push(
                        `${at} Missing required field "${key}". Add ${key}: ${valueHint(fieldDef, key)}.`,
                    );
            } else if (fieldDef.type === 'string[]' || fieldDef.type === 'object[]') {
                errors.push(...arrayFieldErrors(`${at}.${key}`, element[key], fieldDef));
            } else if (typeof element[key] !== fieldDef.type) {
                errors.push(`${at}.${key} must be ${fieldDef.type}, got ${typeof element[key]}.`);
            }
        }
    });
    return errors;
}

// webpieces-disable no-any-unknown -- rawRules values are opaque JSON; each field is validated individually
export function validateWebpiecesConfig(
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    rawRules: Record<string, Record<string, unknown>>,
    registry: RulePackRegistry,
): string[] {
    const errors: string[] = [];
    const advice = new RuleConfigAdvice(registry);

    // Check field-level correctness for rules that are present
    for (const [ruleName, entry] of Object.entries(rawRules)) {
        const schema = registry.hasRule(ruleName) ? registry.schemaFor(ruleName) : undefined;
        if (!schema) {
            if (
                registry.isSafeguard(ruleName) &&
                !registry
                    .migrations()
                    .some(
                        (entry: RetiredConfigKey) =>
                            entry.scope === 'rule' && entry.key === ruleName,
                    )
            ) {
                errors.push(
                    `[${ruleName}] is a cataloged safeguard, not a configurable policy. Delete its config entry; fixed safety cannot be disabled.`,
                );
                continue;
            }
            // A name we KNOW is retired beats the generic unknown-rule message, because only the table
            // knows WHERE the setting went — a rename carries its value over, and a bare "delete it"
            // would throw that value away. Client packs must not reuse a retired canonical ID.
            const retired = retiredRuleFor(ruleName, registry);
            if (retired) {
                errors.push(retiredKeyError(retired));
                continue;
            }
            // Client policies require a schema from an explicitly selected owner.
            errors.push(unknownRuleError(ruleName));
            continue;
        }
        errors.push(...fieldErrors(ruleName, entry, schema, registry));
        // Required fields must actually be present. Until now the loop above only checked
        // fields that WERE present, so an entry like `{}` (or one missing `mode` /
        // `turnOffRuleUntilEpoch`) slipped through. Every non-optional schema field is mandatory.
        for (const [key, fieldDef] of Object.entries(schema)) {
            if (!fieldDef.optional && !(key in entry)) {
                errors.push(
                    `[${ruleName}] Missing required field "${key}". Add ${key}: ${valueHint(fieldDef, key)}.`,
                );
            }
        }
    }

    // Every built-in rule must be explicitly configured — no silent defaults.
    // When a new rule is added to the framework, this check surfaces it immediately
    // with a ready-to-copy snippet so AI can configure it in one pass.
    for (const ruleName of registry.ruleIds()) {
        const schema = registry.schemaFor(ruleName);
        if (!(ruleName in rawRules)) {
            errors.push(advice.missingRuleSnippet(ruleName, schema));
        }
    }

    return errors;
}

export { validatePrGateSection } from './validate-pr-gate';

function excludePathsExample(): string {
    return '"excludePaths": ["repositories/**"]';
}

// A glob list: must be a string[] (may be empty). `key` names it for the error.
// webpieces-disable no-any-unknown -- `value` is opaque consumer JSON until narrowed here
function validateExcludeList(value: unknown, key: string): string[] {
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    if (!(Array.isArray(value) && value.every((p: unknown) => typeof p === 'string'))) {
        return [`[excludePaths] "${key}" must be a string[] of glob paths (use [] for none).`];
    }
    return [];
}

/**
 * Validate the REQUIRED top-level `excludePaths` block: ONE glob list suppressing hook enforcement per
 * file path, for code-style rules and file-scoped guards alike. Required so every client upgrading is
 * forced to declare it (as [] to keep today's behavior, or with real paths). Returns copy-paste
 * friendly errors and never throws — same contract as validatePrGateSection.
 *
 * The two-list object form `{ "rules": [...], "guards": [...] }` is RETIRED, not tolerated. It used to be
 * accepted and silently unioned, which is why this repo's own config sat on the dead shape for releases: an
 * accepted shape is never migrated. Rejecting it cannot wedge a consumer — editing webpieces.config.json is
 * always permitted, even while it is invalid. See retired-config-keys.ts.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed below
export function validateExcludePaths(section: unknown): string[] {
    if (section === undefined || section === null) {
        return [
            `[excludePaths] Not configured in webpieces.config.json. Add this REQUIRED block ` +
                `(use an empty array to keep enforcing everywhere):\n\n  ${excludePathsExample()}`,
        ];
    }
    if (Array.isArray(section)) return validateExcludeList(section, 'excludePaths');
    if (typeof section !== 'object') {
        return [
            `[excludePaths] Must be a string[] of glob paths. Example:\n\n  ${excludePathsExample()}`,
        ];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque excludePaths section from consumer JSON
    const s = section as Record<string, unknown>;
    // The retired two-list object. One table row owns the message for either key present.
    const retired = retiredEntry('rules', '[excludePaths]');
    if (retired && (s['rules'] !== undefined || s['guards'] !== undefined)) {
        return [`${retiredKeyError(retired)}\n\n  ${excludePathsExample()}`];
    }
    return [
        `[excludePaths] Must be a string[] of glob paths. Example:\n\n  ${excludePathsExample()}`,
    ];
}

// ---------------------------------------------------------------------------
// match-rules — a new top-level ARRAY section (parallel to pr-gate/excludePaths). Each entry is a
// client-authored content guard (raw-regex patterns + message + scoping). Validated structurally here
// the same way pr-gate's `gates` are, because an array of objects can't be expressed in FieldDef schema.
// ---------------------------------------------------------------------------

function matchRulesExample(): string {
    return `"match-rules": ${JSON.stringify(DEFAULT_MATCH_RULES, null, 4)}`;
}

// webpieces-disable no-any-unknown -- generic type guard over an opaque JSON value
function isStringArray(value: unknown): value is string[] {
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    return Array.isArray(value) && value.every((v: unknown) => typeof v === 'string');
}

// Compile a pattern to validate it; returns the error message, or undefined when it compiles.
function regexError(pattern: string): string | undefined {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Constructed only to validate the syntax; the object is intentionally discarded.
        void new RegExp(pattern);
        return undefined;
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    } catch (err: unknown) {
        const error = toError(err);
        return error.message;
    }
}

// One entry of the match-rules array, validated field-by-field (see validateGate for the pattern).
// webpieces-disable no-any-unknown -- one match-rule entry from opaque consumer JSON, validated field-by-field
function validateMatchRule(entry: unknown, index: number): string[] {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return [
            `[match-rules] entry[${index}] must be an object { name, patterns, mainMessage, mode, turnOffRuleUntilEpoch, turnOffRuleWhileOnBranch, ... }.`,
        ];
    }
    // webpieces-disable no-any-unknown -- narrowing one opaque match-rule entry from consumer JSON
    const e = entry as Record<string, unknown>;
    const label = typeof e['name'] === 'string' ? `"${e['name']}"` : `entry[${index}]`;
    const errors: string[] = [];

    if (typeof e['name'] !== 'string' || e['name'].trim() === '')
        errors.push(
            `[match-rules] entry[${index}].name must be a non-empty string (it is the disable token and report label).`,
        );

    if (!isStringArray(e['patterns']) || e['patterns'].length === 0) {
        errors.push(`[match-rules] ${label}.patterns must be a non-empty string[] of regexes.`);
    } else {
        e['patterns'].forEach((p: string, pi: number) => {
            const rxErr = regexError(p);
            if (rxErr)
                errors.push(
                    `[match-rules] ${label}.patterns[${pi}] is not a valid regex: ${rxErr}`,
                );
        });
    }

    if (typeof e['mainMessage'] !== 'string' || e['mainMessage'].trim() === '')
        errors.push(`[match-rules] ${label}.mainMessage must be a non-empty string.`);

    if (
        typeof e['mode'] !== 'string' ||
        !MODIFIED_CODE_MODES.includes(e['mode'] as (typeof MODIFIED_CODE_MODES)[number])
    )
        errors.push(
            `[match-rules] ${label}.mode must be one of: ${MODIFIED_CODE_MODES.join(', ')}.`,
        );

    errors.push(...validateMatchRuleHatches(e, label));

    if (e['options'] !== undefined && !isStringArray(e['options']))
        errors.push(`[match-rules] ${label}.options must be a string[] (omit if not needed).`);
    if (e['allowedPaths'] !== undefined && !isStringArray(e['allowedPaths']))
        errors.push(
            `[match-rules] ${label}.allowedPaths must be a string[] of globs (omit if not needed).`,
        );
    if (e['disableAllowed'] !== undefined && typeof e['disableAllowed'] !== 'boolean')
        errors.push(`[match-rules] ${label}.disableAllowed must be a boolean.`);

    return errors;
}

/**
 * Validate the REQUIRED top-level `match-rules` array (client-authored content guards). MISSING →
 * one error printing the ready-to-paste `no-fetch` example (add at least this; more can follow).
 * Present-but-`[]` → allowed (a conscious opt-out, matching pr-gate mode:OFF / excludePaths []).
 * Otherwise every entry is validated field-by-field (each regex compile-checked) plus name
 * uniqueness. Copy-paste-friendly errors; never throws — same contract as validatePrGateSection.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed below
export function validateMatchRulesSection(section: unknown): string[] {
    if (section === undefined || section === null) {
        return [
            `[match-rules] Not configured in webpieces.config.json. Add this REQUIRED top-level array — ` +
                `seed it with the no-fetch guard below (you can add more entries: no-moment, no-lodash-chain, …):\n\n${matchRulesExample()}`,
        ];
    }
    if (!Array.isArray(section)) {
        return [
            `[match-rules] Must be an array of content-guard objects. Example:\n\n${matchRulesExample()}`,
        ];
    }

    const errors: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < section.length; i += 1) {
        errors.push(...validateMatchRule(section[i], i));
        // webpieces-disable no-any-unknown -- reading the name off an opaque entry only to dedupe
        const name = (section[i] as Record<string, unknown> | null)?.['name'];
        if (typeof name === 'string') {
            if (seen.has(name))
                errors.push(
                    `[match-rules] duplicate entry name "${name}" — each match-rule name must be unique.`,
                );
            seen.add(name);
        }
    }
    return errors;
}

// webpieces-disable no-any-unknown -- explicit match-rule JSON is checked field by field
// webpieces-disable no-function-outside-class -- pure validation helper
function validateMatchRuleHatches(e: Record<string, unknown>, label: string): string[] {
    const errors: string[] = [];
    // Both escape hatches are REQUIRED on every match-rule too (same as keyed rules), so they are always
    // visible. turnOffRuleUntilEpoch: number (0 = active; a future unix-epoch in seconds = temporarily
    // off). turnOffRuleWhileOnBranch: string | null (null = always on; an EXACT branch name — matched
    // with ===, never as a glob — disables the rule while that branch is checked out).
    if (typeof e['turnOffRuleUntilEpoch'] !== 'number') {
        errors.push(
            `[match-rules] ${label}.turnOffRuleUntilEpoch must be a number (0 = active; future unix-epoch seconds = temporarily off).`,
        );
    } else {
        const capError = epochCapError(`[match-rules] ${label}`, e['turnOffRuleUntilEpoch']);
        if (capError) errors.push(capError);
    }
    if (
        !(
            e['turnOffRuleWhileOnBranch'] === null ||
            typeof e['turnOffRuleWhileOnBranch'] === 'string'
        )
    )
        errors.push(
            `[match-rules] ${label}.turnOffRuleWhileOnBranch must be a string or null (null = no branch / always on; a string is an EXACT branch name, globs are not supported).`,
        );

    // The old escape-hatch names were renamed — flag them precisely.
    for (const oldKey of new PolicyFieldConstraints().retiredFields()) {
        if (oldKey in e)
            errors.push(
                renamedFieldError(`[match-rules] ${label}`, oldKey, new PolicyFieldConstraints().renamedField(oldKey)!),
            );
    }

    return errors;
}
