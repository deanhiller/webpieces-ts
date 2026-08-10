import * as fs from 'fs';
import * as path from 'path';
import { FieldDef } from './field-def';
// Imported, never re-typed: the banner offers the bulk migrator only for errors it actually covers, and
// this marker is how it recognizes a placement error. See config-error-banner.ts.
import { SECTION_PLACEMENT_MARKER } from './config-error-banner';
import { sectionForRule, isHookGuard } from './sections';
import { RULE_SCHEMAS, allRuleNames } from './rule-schemas';
import { recommendedSeedModeFor, isGradualMode } from './seed-entry';
import { MODIFIED_CODE_MODES } from './rule-configs';
import { validateChecklistsSection, validateDevDeploySection, validateLandPrSection, validateNoGateSaltRationale } from './pr-gate-section-validators';
import { retiredEntry, retiredKeyError, retiredRuleFor } from './retired-config-keys';
import { PRUNE_UNKNOWN_COMMAND } from './constants';

// Re-exported so the isolated validate-checklist-docs target keeps importing it from here.
export { validateChecklistsSection };
// Re-exported from their new homes: this module was the historical entry point for both.
export { allRuleNames } from './rule-schemas';
export { recommendedSeedMode, recommendedSeedModeFor, seedEntryForRule } from './seed-entry';
import { DEFAULT_MATCH_RULES } from './match-rules-config';
import { toError } from './to-error';

function valueHint(def: FieldDef, key?: string): string {
    // The two universal escape hatches, REQUIRED on every rule so they're always visible. Spell out the
    // "off" value so a fresh config seeds them in the active/no-op state (0 / null), not a placeholder.
    if (key === 'turnOffRuleUntilEpoch') return '0  (0 = active; future unix-epoch seconds = temporarily off)';
    if (key === 'turnOffRuleWhileOnBranch') return 'null  (null = always on; a branch name disables the rule while that branch is checked out)';
    return def.enumValues
        ? `"${def.enumValues.join(' | ')}"`
        : def.type === 'string[]' ? '["<string>", ...]'
        : def.type === 'number'   ? '<number>'
        : def.type === 'boolean'  ? '<boolean>'
        : '"<string>"';
}

/** A rollout hint for the copy-paste snippet: recommend the narrowest gradual mode the rule supports. */
function rolloutTip(schema: Record<string, FieldDef>): string {
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

function missingRuleSnippet(ruleName: string, schema: Record<string, FieldDef>): string {
    // Required fields go in the copy-paste entry. The two universal escape hatches
    // (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch) are now REQUIRED, so they land in that block —
    // which is the whole point: every seeded rule shows both hatches. Optional fields are listed separately.
    const fields = Object.keys(schema);
    const required = fields.filter(f => !schema[f].optional);
    const optional = fields.filter(f => schema[f].optional);

    const requiredLines = required.map(f => `    "${f}": ${valueHint(schema[f], f)}`);
    const section = sectionForRule(ruleName);
    let out =
        `[${ruleName}] Not configured in webpieces.config.json. Add this entry to the "${section}" section\n` +
        `(choose values appropriate for your project):\n\n` +
        `  "${ruleName}": {\n${requiredLines.join(',\n')}\n  }`;

    if (optional.length > 0) {
        const optionalLines = optional.map(f => `    "${f}": ${valueHint(schema[f], f)}`);
        out +=
            `\n\nOptional fields you may add to this rule (omit if not needed):\n` +
            `${optionalLines.join(',\n')}`;
    }
    out += rolloutTip(schema);
    return out;
}

/**
 * A config key under rules/hookGuards that the RUNNING validator has no schema for (and no rulesDir is set
 * to supply custom rules). THE FALLBACK: it fires for any name the table in retired-config-keys.ts does not
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
        `[${ruleName}] Unknown rule — the running @webpieces validator has no schema for it, and no ` +
        `"rulesDir" is configured to supply custom rules. A key no validator knows controls NOTHING, so ` +
        `DELETE the "${ruleName}" key from webpieces.config.json — run \`${PRUNE_UNKNOWN_COMMAND}\` to ` +
        `strip it (and every other unknown key) mechanically. It may be RETIRED: a newer release can move ` +
        `a setting out of this file entirely, in which case deleting the key here is the WHOLE fix. ` +
        `MACHINE-LOCAL settings in particular now live in ~/.webpieces/config.json under "experimental" — ` +
        `an optional file tracked by no repo, whose absence is the default behaviour — so if ` +
        `"${ruleName}" is one of those, delete it here and set it there. Secondary, and rare: a key is ` +
        `valid-but-unlearned when package.json pins an @webpieces OLDER than this config was written for, ` +
        `and the version-drift guard reports THAT separately with its own cure (bump the pin) before this ` +
        `validator ever runs — so it is not what you are looking at.`
    );
}

// Fields we DELETED from a rule's schema, keyed by "<rule>.<field>". The generic unknown-field error
// ("Unknown field ... Valid fields: [...]") is correct but doesn't say WHY the field vanished, so an AI
// might re-add it. These hints explain the removal so the only action left is to delete the key.
const RETIRED_FIELD_HINTS: Record<string, string> = {
    'runtime-architecture.servicePaths':
        'This field was removed — it was never read. The runtime graph is derived automatically from ' +
        'architecture/dependencies.json (apiRelations + project roles). Delete it.',
    'runtime-architecture.apiProjectPaths':
        'This field was removed — it was never read. The runtime graph is derived automatically from ' +
        'architecture/dependencies.json, so there is NO list of api libs to maintain. Delete it (do not ' +
        'enumerate api libs and do not replace it with a glob).',
};

// Universal field renames (apply to EVERY rule/guard AND every match-rule, unlike the per-rule
// RETIRED_FIELD_HINTS). When an entry still uses the old escape-hatch name, the generic unknown-field
// error is replaced with a precise "renamed to X — rename it" instruction so the fix is mechanical.
const RENAMED_FIELD_ALIASES: Record<string, string> = {
    ignoreModifiedUntilEpoch: 'turnOffRuleUntilEpoch',
    ignoreRuleWhileOnBranch: 'turnOffRuleWhileOnBranch',
};


// The renamed-field message shared by keyed rules and match-rules.
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function renamedFieldError(scope: string, oldKey: string, newKey: string): string {
    return `${scope} Unknown field "${oldKey}" — it was renamed to "${newKey}". Rename it (the value carries over unchanged; for the branch hatch, use null when there is no branch).`;
}

// webpieces-disable no-any-unknown -- rawRules values are opaque JSON; each field is validated individually
export function validateWebpiecesConfig(
    rawRules: Record<string, Record<string, unknown>>,
    hasCustomRulesDir: boolean = false,
): string[] {
    const errors: string[] = [];

    // Check field-level correctness for rules that are present
    for (const [ruleName, entry] of Object.entries(rawRules)) {
        const schema = RULE_SCHEMAS[ruleName];
        if (!schema) {
            // A name we KNOW is retired beats the generic unknown-rule message, because only the table
            // knows WHERE the setting went — a rename carries its value over, and a bare "delete it"
            // would throw that value away. It fires even when a rulesDir is set, because a custom rule
            // must not reuse a retired name.
            const retired = retiredRuleFor(ruleName);
            if (retired) {
                errors.push(retiredKeyError(retired));
                continue;
            }
            // No built-in schema. With no rulesDir there are no custom rules, so this key is a
            // dead/typo'd entry — tell the AI to remove it (a removed rule like no-shell-substitution
            // lingers here otherwise). With a rulesDir it may be a legitimate custom rule → skip.
            if (!hasCustomRulesDir) errors.push(unknownRuleError(ruleName));
            continue;
        }
        for (const [key, value] of Object.entries(entry)) {
            const fieldDef = schema[key];
            if (!fieldDef) {
                const renamedTo = RENAMED_FIELD_ALIASES[key];
                if (renamedTo) {
                    errors.push(renamedFieldError(`[${ruleName}]`, key, renamedTo));
                    continue;
                }
                const retiredHint = RETIRED_FIELD_HINTS[`${ruleName}.${key}`];
                const suffix = retiredHint ? ` ${retiredHint}` : '';
                errors.push(`[${ruleName}] Unknown field "${key}". Valid fields: [${Object.keys(schema).join(', ')}].${suffix}`);
                continue;
            }
            // A nullable field (e.g. turnOffRuleWhileOnBranch) accepts JSON null in addition to its type.
            if (value === null && fieldDef.nullable) continue;
            if (fieldDef.type === 'string[]') {
                if (!Array.isArray(value) || !value.every(v => typeof v === 'string'))
                    errors.push(`[${ruleName}] "${key}" must be string[], got ${typeof value}.`);
            } else if (typeof value !== fieldDef.type) {
                errors.push(`[${ruleName}] "${key}" must be ${fieldDef.type}, got ${typeof value}.`);
            } else if (fieldDef.enumValues && !fieldDef.enumValues.includes(value as string)) {
                errors.push(`[${ruleName}] "${key}" = "${value}" is not valid. Must be one of: ${fieldDef.enumValues.join(', ')}.`);
            }
        }
        // Required fields must actually be present. Until now the loop above only checked
        // fields that WERE present, so an entry like `{}` (or one missing `mode` /
        // `turnOffRuleUntilEpoch`) slipped through. Every non-optional schema field is mandatory.
        for (const [key, fieldDef] of Object.entries(schema)) {
            if (!fieldDef.optional && !(key in entry)) {
                errors.push(`[${ruleName}] Missing required field "${key}". Add ${key}: ${valueHint(fieldDef, key)}.`);
            }
        }
    }

    // Every built-in rule must be explicitly configured — no silent defaults.
    // When a new rule is added to the framework, this check surfaces it immediately
    // with a ready-to-copy snippet so AI can configure it in one pass.
    for (const [ruleName, schema] of Object.entries(RULE_SCHEMAS)) {
        if (!(ruleName in rawRules)) {
            errors.push(missingRuleSnippet(ruleName, schema));
        }
    }

    return errors;
}

const PR_GATE_MODES = ['ON', 'OFF'] as const;
// Optional — omitted means DETECT. Kept inline (like prGateExample) to avoid a load-config ↔
// pr-gate-config import cycle; the canonical list + semantics live in pr-gate-config.ts.
const PR_GATE_MERGE_MODES = ['AUTO', 'NONE'] as const;

// Spelled out because the choice is a POLICY decision with a consequence the chooser cannot see:
// only the AUTO path can put the compact risk/flags body in main's history, because a UI merge is
// composed from the repo's squash_merge_commit_title/message settings, which the tooling pins.
const MERGE_MODE_HELP = (
        `Must be one of: ${PR_GATE_MERGE_MODES.join(', ')}.\n` +
        `  "AUTO" — wp-finish-upsert-pr lands the PR: it squash-merges when mergeable, else enables\n` +
        `           GitHub auto-merge, both with an explicit --subject/--body-file so main's history\n` +
        `           gets the PR title + the compact risk/flags body. Needs allow_auto_merge on the repo\n` +
        `           (gh api repos/{owner}/{repo} --jq .allow_auto_merge).\n` +
        `  "NONE" — wp-finish-upsert-pr only opens/updates the PR; a human merges it, and that still\n` +
        `           lands the compact body: the PR DESCRIPTION *is* that body, and stage \u2462 keeps the repo's\n` +
        `           squash_merge_commit_title/message pinned to PR_TITLE/PR_BODY so a UI merge copies it\n` +
        `           verbatim (SquashSettingsEnforcer). Nothing to set by hand.`
);

// Copy-paste example for the top-level `pr-gate` block (sibling of `rules`). Kept inline rather
// than imported from pr-gate-config.ts to avoid a load-config ↔ pr-gate-config import cycle.
function prGateExample(): string {
    return (
        `  "pr-gate": {\n` +
        `    "mode": "ON",\n` +
        `    "buildCommand": "<command CI runs to validate a PR, e.g. pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)>",\n` +
        `    "gates": [\n` +
        `      { "name": "API Changed", "patterns": ["libraries/apis/**", "**/*Api.ts"], "warningColor": "yellow" }\n` +
        `    ],\n` +
        `    "checklists": [   // OPTIONAL — per-area review, one distinct reviewer subagent each\n` +
        `      { "subagent": "db-migration-reviewer", "doc": ".claude/review/db-migrations.md", "patterns": ["**/*.sql"] }\n` +
        `    ]\n` +
        `  }`
    );
}

// The `gates` array: dashboard-only warning flags. Extracted from validatePrGateSection to keep that
// method inside the length limit.
// webpieces-disable no-any-unknown -- `value` is the opaque consumer `gates` value until narrowed here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function validateGatesSection(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [`[pr-gate] "gates" must be an array of { name, patterns, warningColor, disabled? }.`];
    }
    const errors: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
        errors.push(...validateGate(value[i], i));
    }
    return errors;
}

// webpieces-disable no-any-unknown -- one gate entry from opaque consumer JSON, validated field-by-field
function validateGate(gate: unknown, index: number): string[] {
    if (typeof gate !== 'object' || gate === null) {
        return [`[pr-gate] gates[${index}] must be an object { name, patterns, warningColor, disabled? }.`];
    }
    // webpieces-disable no-any-unknown -- narrowing one opaque gate object from consumer JSON
    const g = gate as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof g['name'] !== 'string') errors.push(`[pr-gate] gates[${index}].name must be a string.`);
    if (!Array.isArray(g['patterns']) || !g['patterns'].every(p => typeof p === 'string'))
        errors.push(`[pr-gate] gates[${index}].patterns must be string[].`);
    if (g['warningColor'] === undefined)
        errors.push(`[pr-gate] gates[${index}].warningColor is required — set it to "yellow" or "red" (green is implicit when nothing matches).`);
    else if (g['warningColor'] !== 'yellow' && g['warningColor'] !== 'red')
        errors.push(`[pr-gate] gates[${index}].warningColor must be "yellow" or "red" (green is implicit when nothing matches).`);
    if (g['disabled'] !== undefined && typeof g['disabled'] !== 'boolean')
        errors.push(`[pr-gate] gates[${index}].disabled must be a boolean (example/inactive gate kept in the file).`);
    return errors;
}

/**
 * Validate the top-level `pr-gate` section. It is REQUIRED (a client that opts out sets mode "OFF").
 * `buildCommand` is required unless mode is "OFF". Returns human-readable, copy-paste-friendly errors
 * — never throws. The pr-gate block lives outside the FieldDef-driven `rules` schema because its
 * nested `gates`/`checklists` arrays can't be expressed there, so they get structural validation here.
 * `repoRoot` (when known) lets the `checklists[].docs` existence check run.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed below
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validatePrGateSection(section: unknown, repoRoot?: string): string[] {
    if (section === undefined || section === null) {
        return [
            `[pr-gate] Not configured in webpieces.config.json. Add this block under the "commands" ` +
            `section (set "mode": "OFF" to opt out):\n\n${prGateExample()}`,
        ];
    }
    if (typeof section !== 'object' || Array.isArray(section)) {
        return [`[pr-gate] Must be an object. Example:\n\n${prGateExample()}`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque pr-gate section from consumer JSON
    const s = section as Record<string, unknown>;
    const errors: string[] = [];

    if (!('mode' in s)) {
        errors.push(`[pr-gate] Missing required field "mode". Must be one of: ${PR_GATE_MODES.join(', ')}.`);
    } else if (typeof s['mode'] !== 'string' || !PR_GATE_MODES.includes(s['mode'] as typeof PR_GATE_MODES[number])) {
        errors.push(`[pr-gate] "mode" = "${String(s['mode'])}" is not valid. Must be one of: ${PR_GATE_MODES.join(', ')}.`);
    }

    // buildCommand and mergeMode are both required whenever the gate is active (mode !== OFF). There
    // is deliberately NO default for mergeMode: whether the tooling may land your PRs is a policy
    // decision, and either guess is wrong for somebody.
    if (s['mode'] !== 'OFF') {
        const cmd = s['buildCommand'];
        if (typeof cmd !== 'string' || cmd.trim() === '') {
            errors.push(
                `[pr-gate] Missing required field "buildCommand" — the command CI runs to validate a PR. ` +
                `Add e.g. "buildCommand": "pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)".`,
            );
        }
        const mm = s['mergeMode'];
        if (!('mergeMode' in s)) {
            errors.push(`[pr-gate] Missing required field "mergeMode". ${MERGE_MODE_HELP}`);
        } else if (typeof mm !== 'string' || !PR_GATE_MERGE_MODES.includes(mm as typeof PR_GATE_MERGE_MODES[number])) {
            errors.push(`[pr-gate] "mergeMode" = "${String(mm)}" is not valid. ${MERGE_MODE_HELP}`);
        }
    }

    if ('gates' in s) errors.push(...validateGatesSection(s['gates']));

    // Optional extension point: company review checklists, as an ARRAY right here in the config. Absent ⇒
    // none. The removed { doc } manifest shape is rejected with the exact migration edit.
    if ('checklists' in s) errors.push(...validateChecklistsSection(s['checklists'], repoRoot));

    // Optional server-token salt. Absent ⇒ no token minted, CI enforcement is a no-op. Present ⇒ must be
    // a non-empty string (an empty salt would mint a token anyone can forge from a known-empty secret).
    if ('gateSalt' in s) {
        const salt = s['gateSalt'];
        if (typeof salt !== 'string' || salt.trim() === '') {
            errors.push(`[pr-gate] "gateSalt" must be a non-empty string — it is the shared secret the gate token is HMAC'd with. Omit the key entirely to disable server-side token enforcement.`);
        }
    }

    // Optional: what happens to the LOCAL branch once its PR lands. Absent ⇒ "archive-tag".
    if ('landPr' in s) errors.push(...validateLandPrSection(s['landPr']));

    // Optional: where wp-push-dev publishes the disposable copy. Absent ⇒ "dev-include" / "dev".
    if ('devDeploy' in s) errors.push(...validateDevDeploySection(s['devDeploy']));

    errors.push(...validateNoGateSaltRationale(s));

    // Optional: publish reviewer output as a PR comment (defaults true). Must be a boolean when present.
    if ('checklistComments' in s && typeof s['checklistComments'] !== 'boolean') {
        errors.push(`[pr-gate] "checklistComments" must be a boolean (defaults to true; set false to keep the PR body-only).`);
    }

    return errors;
}

function excludePathsExample(): string {
    return '"excludePaths": ["repositories/**"]';
}

// A glob list: must be a string[] (may be empty). `key` names it for the error.
// webpieces-disable no-any-unknown -- `value` is opaque consumer JSON until narrowed here
function validateExcludeList(value: unknown, key: string): string[] {
    if (!(Array.isArray(value) && value.every(p => typeof p === 'string'))) {
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
        return [`[excludePaths] Must be a string[] of glob paths. Example:\n\n  ${excludePathsExample()}`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque excludePaths section from consumer JSON
    const s = section as Record<string, unknown>;
    // The retired two-list object. One table row owns the message for either key present.
    const retired = retiredEntry('rules', '[excludePaths]');
    if (retired && (s['rules'] !== undefined || s['guards'] !== undefined)) {
        return [`${retiredKeyError(retired)}\n\n  ${excludePathsExample()}`];
    }
    return [`[excludePaths] Must be a string[] of glob paths. Example:\n\n  ${excludePathsExample()}`];
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
    return Array.isArray(value) && value.every(v => typeof v === 'string');
}

// Compile a pattern to validate it; returns the error message, or undefined when it compiles.
function regexError(pattern: string): string | undefined {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Constructed only to validate the syntax; the object is intentionally discarded.
        void new RegExp(pattern);
        return undefined;
    } catch (err: unknown) {
        const error = toError(err);
        return error.message;
    }
}

// One entry of the match-rules array, validated field-by-field (see validateGate for the pattern).
// webpieces-disable no-any-unknown -- one match-rule entry from opaque consumer JSON, validated field-by-field
function validateMatchRule(entry: unknown, index: number): string[] {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return [`[match-rules] entry[${index}] must be an object { name, patterns, mainMessage, mode, turnOffRuleUntilEpoch, turnOffRuleWhileOnBranch, ... }.`];
    }
    // webpieces-disable no-any-unknown -- narrowing one opaque match-rule entry from consumer JSON
    const e = entry as Record<string, unknown>;
    const label = typeof e['name'] === 'string' ? `"${e['name']}"` : `entry[${index}]`;
    const errors: string[] = [];

    if (typeof e['name'] !== 'string' || e['name'].trim() === '')
        errors.push(`[match-rules] entry[${index}].name must be a non-empty string (it is the disable token and report label).`);

    if (!isStringArray(e['patterns']) || e['patterns'].length === 0) {
        errors.push(`[match-rules] ${label}.patterns must be a non-empty string[] of regexes.`);
    } else {
        e['patterns'].forEach((p: string, pi: number) => {
            const rxErr = regexError(p);
            if (rxErr) errors.push(`[match-rules] ${label}.patterns[${pi}] is not a valid regex: ${rxErr}`);
        });
    }

    if (typeof e['mainMessage'] !== 'string' || e['mainMessage'].trim() === '')
        errors.push(`[match-rules] ${label}.mainMessage must be a non-empty string.`);

    if (typeof e['mode'] !== 'string' || !MODIFIED_CODE_MODES.includes(e['mode'] as typeof MODIFIED_CODE_MODES[number]))
        errors.push(`[match-rules] ${label}.mode must be one of: ${MODIFIED_CODE_MODES.join(', ')}.`);

    // Both escape hatches are REQUIRED on every match-rule too (same as keyed rules), so they are always
    // visible. turnOffRuleUntilEpoch: number (0 = active; a future unix-epoch in seconds = temporarily
    // off). turnOffRuleWhileOnBranch: string | null (null = always on; a branch name disables the rule
    // while that branch is checked out).
    if (typeof e['turnOffRuleUntilEpoch'] !== 'number')
        errors.push(`[match-rules] ${label}.turnOffRuleUntilEpoch must be a number (0 = active; future unix-epoch seconds = temporarily off).`);
    if (!(e['turnOffRuleWhileOnBranch'] === null || typeof e['turnOffRuleWhileOnBranch'] === 'string'))
        errors.push(`[match-rules] ${label}.turnOffRuleWhileOnBranch must be a string or null (null = no branch / always on).`);

    // The old escape-hatch names were renamed — flag them precisely.
    for (const oldKey of Object.keys(RENAMED_FIELD_ALIASES)) {
        if (oldKey in e) errors.push(renamedFieldError(`[match-rules] ${label}`, oldKey, RENAMED_FIELD_ALIASES[oldKey]));
    }

    if (e['options'] !== undefined && !isStringArray(e['options']))
        errors.push(`[match-rules] ${label}.options must be a string[] (omit if not needed).`);
    if (e['allowedPaths'] !== undefined && !isStringArray(e['allowedPaths']))
        errors.push(`[match-rules] ${label}.allowedPaths must be a string[] of globs (omit if not needed).`);
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
        return [`[match-rules] Must be an array of content-guard objects. Example:\n\n${matchRulesExample()}`];
    }

    const errors: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < section.length; i += 1) {
        errors.push(...validateMatchRule(section[i], i));
        // webpieces-disable no-any-unknown -- reading the name off an opaque entry only to dedupe
        const name = (section[i] as Record<string, unknown> | null)?.['name'];
        if (typeof name === 'string') {
            if (seen.has(name)) errors.push(`[match-rules] duplicate entry name "${name}" — each match-rule name must be unique.`);
            seen.add(name);
        }
    }
    return errors;
}

/**
 * Enforce that each built-in lives in its correct section: code rules under `rules`, bash guards
 * under `hookGuards`. A guard left in `rules` (or a rule placed in `hookGuards`) is reported with a
 * "move it" message so the split stays clean. Unknown/custom names are ignored (they may be custom
 * rules from rulesDir). Presence ("every built-in must be configured") is checked separately by
 * validateWebpiecesConfig against the merged map.
 */
// webpieces-disable no-any-unknown -- section maps are opaque consumer JSON
export function validateSectionPlacement(
    rulesSection: Record<string, Record<string, unknown>>,
    hookGuardsSection: Record<string, Record<string, unknown>>,
): string[] {
    const errors: string[] = [];
    for (const name of Object.keys(rulesSection)) {
        if (isHookGuard(name)) {
            errors.push(
                `[${name}] is a hook guard and ${SECTION_PLACEMENT_MARKER} "hookGuards" section, not "rules". ` +
                `Move it.`,
            );
        }
    }
    for (const name of Object.keys(hookGuardsSection)) {
        // Only flag KNOWN code rules misplaced into hookGuards; unknown names may be custom rules.
        if (!isHookGuard(name) && RULE_SCHEMAS[name]) {
            errors.push(
                `[${name}] is a code rule and ${SECTION_PLACEMENT_MARKER} "rules" section, not "hookGuards". ` +
                `Move it.`,
            );
        }
    }
    return errors;
}
