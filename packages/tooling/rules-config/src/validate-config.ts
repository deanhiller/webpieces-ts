import { FieldDef } from './field-def';
import { sectionForRule, isHookGuard } from './sections';
import { MODIFIED_CODE_MODES } from './rule-configs';
import { DEFAULT_MATCH_RULES } from './match-rules-config';
import { toError } from './to-error';
import {
    MaxMethodLinesConfig,
    MaxFileLinesConfig,
    RequireReturnTypeConfig,
    NoInlineTypeLiteralsConfig,
    NoAnyUnknownConfig,
    NoImplicitAnyConfig,
    PrismaValidateDtosConfig,
    PrismaConverterConfig,
    NoDestructureConfig,
    NoUnmanagedExceptionsConfig,
    CatchErrorPatternConfig,
    ThrowCauseRequiredConfig,
    AngularNoDirectApiInResolverConfig,
    NoSymbolDiTokensConfig,
    NoProcessExitOutsideMainConfig,
    FrameworkTagConfig,
    RoleTagConfig,
    BranchCreationGuardConfig,
    PrCreationOrPushGuardConfig,
    MergeInProgressGuardConfig,
    PrMergeGuardConfig,
    RedirectHowToMergeMainConfig,
    FeatureBranchGuardConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NxWiringConfig,
    DiGraphConfig,
    MissingDesignAnnotationConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
} from './rule-configs';

// Thin lookup table — each entry delegates to the class's own SCHEMA.
// No field lists here; all schemas live with their config class.
const RULE_SCHEMAS: Record<string, Record<string, FieldDef>> = {
    'max-method-lines': MaxMethodLinesConfig.SCHEMA,
    'max-file-lines': MaxFileLinesConfig.SCHEMA,
    'require-return-type': RequireReturnTypeConfig.SCHEMA,
    'no-inline-type-literals': NoInlineTypeLiteralsConfig.SCHEMA,
    'no-any-unknown': NoAnyUnknownConfig.SCHEMA,
    'no-implicit-any': NoImplicitAnyConfig.SCHEMA,
    'prisma-validate-dtos': PrismaValidateDtosConfig.SCHEMA,
    'prisma-converter': PrismaConverterConfig.SCHEMA,
    'no-destructure': NoDestructureConfig.SCHEMA,
    'no-unmanaged-exceptions': NoUnmanagedExceptionsConfig.SCHEMA,
    'catch-error-pattern': CatchErrorPatternConfig.SCHEMA,
    'throw-cause-required': ThrowCauseRequiredConfig.SCHEMA,
    'angular-no-direct-api-in-resolver': AngularNoDirectApiInResolverConfig.SCHEMA,
    'no-symbol-di-tokens': NoSymbolDiTokensConfig.SCHEMA,
    'no-process-exit-outside-main': NoProcessExitOutsideMainConfig.SCHEMA,
    'framework-tag': FrameworkTagConfig.SCHEMA,
    'role-tag': RoleTagConfig.SCHEMA,
    'branch-creation-guard': BranchCreationGuardConfig.SCHEMA,
    'pr-creation-or-push-guard': PrCreationOrPushGuardConfig.SCHEMA,
    'merge-in-progress-guard': MergeInProgressGuardConfig.SCHEMA,
    'pr-merge-guard': PrMergeGuardConfig.SCHEMA,
    'redirect-how-to-merge-main': RedirectHowToMergeMainConfig.SCHEMA,
    'feature-branch-guard': FeatureBranchGuardConfig.SCHEMA,
    'no-file-import-cycles': NoFileImportCyclesConfig.SCHEMA,
    'runtime-architecture': RuntimeArchitectureConfig.SCHEMA,
    'nx-wiring': NxWiringConfig.SCHEMA,
    'di-graph': DiGraphConfig.SCHEMA,
    'missing-design-annotation': MissingDesignAnnotationConfig.SCHEMA,
    'no-js-files': NoJsFilesConfig.SCHEMA,
    'validate-ts-in-src': ValidateTsInSrcConfig.SCHEMA,
};

// Every built-in rule name that has a typed schema (code rules + bash guards). The installer uses
// this (with sectionForRule) to seed a fresh webpieces.config.json with every rule in its section.
export function allRuleNames(): readonly string[] {
    return Object.keys(RULE_SCHEMAS);
}

function valueHint(def: FieldDef, key?: string): string {
    // ignoreModifiedUntilEpoch is required on every rule; 0 keeps the rule active (epoch in the
    // past), a future unix epoch (seconds) temporarily disables it. Spell that out for the AI.
    if (key === 'ignoreModifiedUntilEpoch') return '0  (0 = active; future unix-epoch seconds = temporarily off)';
    return def.enumValues
        ? `"${def.enumValues.join(' | ')}"`
        : def.type === 'string[]' ? '["<string>", ...]'
        : def.type === 'number'   ? '<number>'
        : def.type === 'boolean'  ? '<boolean>'
        : '"<string>"';
}

// Scoped modes (narrowest → broadest) that enforce ONLY on what changed, so a rule can be
// adopted gradually instead of all-at-once. When a rule offers one, recommend the first it
// supports so a fresh config opts into a low-friction rollout rather than reflexively OFF.
const GRADUAL_MODE_PREFERENCE = [
    'MODIFIED_PROJECTS',
    'NEW_AND_MODIFIED_CODE',
    'NEW_AND_MODIFIED_METHODS',
    'MODIFIED_CLASS',
    'NEW_METHODS',
    'NEW_AND_MODIFIED_FILES',
];

/** A rollout hint for the copy-paste snippet: recommend the narrowest gradual mode the rule supports. */
function rolloutTip(schema: Record<string, FieldDef>): string {
    const modes = schema['mode']?.enumValues ?? [];
    const recommended = GRADUAL_MODE_PREFERENCE.find((m: string) => modes.includes(m));
    if (!recommended) return '';
    const optOut = modes.includes('OFF') ? ' Set "mode": "OFF" to opt out entirely.' : '';
    return (
        `\n\n💡 Recommended: start with "mode": "${recommended}" — it enforces only on what you ` +
        `actually change, so the rule rolls out gradually (existing code stays grandfathered until ` +
        `you next touch that project/file/method).${optOut}`
    );
}

function missingRuleSnippet(ruleName: string, schema: Record<string, FieldDef>): string {
    // Only required fields go in the copy-paste entry. Optional fields (e.g. the
    // universal escape hatches ignoreRuleWhileOnBranch / ignoreModifiedUntilEpoch)
    // are listed separately so the snippet doesn't over-state what's mandatory.
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

// A config key under rules/hookGuards that the RUNNING validator has no schema for (and no rulesDir is
// set to supply custom rules). Two very different causes, so the message leads with the common one:
//   1. Version skew (most common — happens right after a dep bump): webpieces.config.json references a
//      rule a NEWER @webpieces release added, but the installed guard is OLDER and doesn't know it yet.
//      Fix = `pnpm install` (NOT deleting the key — the key is valid, the validator is just stale).
//   2. A genuinely removed/renamed rule left behind, or a typo. Fix = remove the key.
// Do NOT tell the AI to delete first — that destroys valid config in case 1 (the trap that made the AI
// gut a working config instead of running `pnpm install`). The banner in load-config.ts spells out the
// ordered "run pnpm install, THEN edit only if it persists" fix.
function unknownRuleError(ruleName: string): string {
    return (
        `[${ruleName}] Unknown rule — the running @webpieces validator has no schema for it, and no ` +
        `"rulesDir" is configured to supply custom rules. Most often this means your installed guard is a ` +
        `release BEHIND this webpieces.config.json: run \`pnpm install\` first (see the fix steps below) so ` +
        `the validator learns "${ruleName}". Only if it is STILL unknown after a fresh install is it a ` +
        `removed/renamed rule or a typo — then remove the "${ruleName}" key from webpieces.config.json.`
    );
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
            // No built-in schema. With no rulesDir there are no custom rules, so this key is a
            // dead/typo'd entry — tell the AI to remove it (a removed rule like no-shell-substitution
            // lingers here otherwise). With a rulesDir it may be a legitimate custom rule → skip.
            if (!hasCustomRulesDir) errors.push(unknownRuleError(ruleName));
            continue;
        }
        for (const [key, value] of Object.entries(entry)) {
            const fieldDef = schema[key];
            if (!fieldDef) {
                errors.push(`[${ruleName}] Unknown field "${key}". Valid fields: [${Object.keys(schema).join(', ')}]`);
                continue;
            }
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
        // `ignoreModifiedUntilEpoch`) slipped through. Every non-optional schema field is mandatory.
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

// Copy-paste example for the top-level `pr-gate` block (sibling of `rules`). Kept inline rather
// than imported from pr-gate-config.ts to avoid a load-config ↔ pr-gate-config import cycle.
function prGateExample(): string {
    return (
        `  "pr-gate": {\n` +
        `    "mode": "ON",\n` +
        `    "buildCommand": "<command CI runs to validate a PR, e.g. pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)>",\n` +
        `    "gates": [\n` +
        `      { "name": "API Changed", "patterns": ["libraries/apis/**", "**/*Api.ts"], "warningColor": "yellow" }\n` +
        `    ]\n` +
        `  }`
    );
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
 * nested `gates` array can't be expressed there, so it gets its own structural validation here.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed below
export function validatePrGateSection(section: unknown): string[] {
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

    // buildCommand is required whenever the gate is active (mode !== OFF).
    if (s['mode'] !== 'OFF') {
        const cmd = s['buildCommand'];
        if (typeof cmd !== 'string' || cmd.trim() === '') {
            errors.push(
                `[pr-gate] Missing required field "buildCommand" — the command CI runs to validate a PR. ` +
                `Add e.g. "buildCommand": "pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)".`,
            );
        }
    }

    if ('gates' in s) {
        const gates = s['gates'];
        if (!Array.isArray(gates)) {
            errors.push(`[pr-gate] "gates" must be an array of { name, patterns, warningColor, disabled? }.`);
        } else {
            for (let i = 0; i < gates.length; i += 1) {
                errors.push(...validateGate(gates[i], i));
            }
        }
    }

    return errors;
}

function excludePathsExample(): string {
    return '"excludePaths": {\n' +
        '    "rules":  ["repositories/**"],\n' +
        '    "guards": []\n' +
        '  }';
}

// One of the two excludePaths lists: required, must be a string[] (may be empty).
// webpieces-disable no-any-unknown -- `value` is opaque consumer JSON until narrowed here
function validateExcludeList(value: unknown, key: string): string[] {
    if (!(Array.isArray(value) && value.every(p => typeof p === 'string'))) {
        return [`[excludePaths] "${key}" must be a string[] of glob paths (use [] for none).`];
    }
    return [];
}

/**
 * Validate the REQUIRED top-level `excludePaths` block: two independent glob lists (`rules`,
 * `guards`) that suppress hook enforcement per file path. Required so every client upgrading is
 * forced to declare it (as [] to keep today's behavior, or with real paths). Returns copy-paste
 * friendly errors and never throws — same contract as validatePrGateSection.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed below
export function validateExcludePaths(section: unknown): string[] {
    if (section === undefined || section === null) {
        return [
            `[excludePaths] Not configured in webpieces.config.json. Add this REQUIRED block ` +
            `(use empty arrays to keep enforcing everywhere):\n\n  ${excludePathsExample()}`,
        ];
    }
    if (typeof section !== 'object' || Array.isArray(section)) {
        return [`[excludePaths] Must be an object with "rules" and "guards" string arrays. Example:\n\n  ${excludePathsExample()}`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque excludePaths section from consumer JSON
    const s = section as Record<string, unknown>;
    return [
        ...validateExcludeList(s['rules'], 'rules'),
        ...validateExcludeList(s['guards'], 'guards'),
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
        return [`[match-rules] entry[${index}] must be an object { name, patterns, mainMessage, mode, ignoreModifiedUntilEpoch, ... }.`];
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

    if (typeof e['ignoreModifiedUntilEpoch'] !== 'number')
        errors.push(`[match-rules] ${label}.ignoreModifiedUntilEpoch must be a number (0 = active; future unix-epoch seconds = temporarily off).`);

    if (e['options'] !== undefined && !isStringArray(e['options']))
        errors.push(`[match-rules] ${label}.options must be a string[] (omit if not needed).`);
    if (e['allowedPaths'] !== undefined && !isStringArray(e['allowedPaths']))
        errors.push(`[match-rules] ${label}.allowedPaths must be a string[] of globs (omit if not needed).`);
    if (e['disableAllowed'] !== undefined && typeof e['disableAllowed'] !== 'boolean')
        errors.push(`[match-rules] ${label}.disableAllowed must be a boolean.`);
    if (e['ignoreRuleWhileOnBranch'] !== undefined && typeof e['ignoreRuleWhileOnBranch'] !== 'string')
        errors.push(`[match-rules] ${label}.ignoreRuleWhileOnBranch must be a string.`);

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
                `[${name}] is a hook guard and belongs in the "hookGuards" section, not "rules". ` +
                `Move it (or run \`wp-setup-ai-hooks --sync\` to migrate automatically).`,
            );
        }
    }
    for (const name of Object.keys(hookGuardsSection)) {
        // Only flag KNOWN code rules misplaced into hookGuards; unknown names may be custom rules.
        if (!isHookGuard(name) && RULE_SCHEMAS[name]) {
            errors.push(
                `[${name}] is a code rule and belongs in the "rules" section, not "hookGuards". ` +
                `Move it (or run \`wp-setup-ai-hooks --sync\` to migrate automatically).`,
            );
        }
    }
    return errors;
}

/**
 * Validate the `commands` section: its `pr-gate` block (delegated to validatePrGateSection) plus the
 * optional command-string fields. Also surfaces a migration error if a DEPRECATED top-level `pr-gate`
 * block is still present, telling the consumer to move it under `commands`.
 */
// webpieces-disable no-any-unknown -- `commands`/`legacyPrGate` are opaque consumer JSON
export function validateCommandsSection(commands: unknown, legacyPrGate: unknown): string[] {
    const errors: string[] = [];

    if (legacyPrGate !== undefined) {
        errors.push(
            `[pr-gate] The top-level "pr-gate" block is deprecated. Move it under the "commands" ` +
            `section as commands["pr-gate"] (run \`wp-setup-ai-hooks --sync\` to migrate automatically).`,
        );
    }

    if (commands !== undefined && (typeof commands !== 'object' || commands === null || Array.isArray(commands))) {
        errors.push(`[commands] Must be an object { "pr-gate": {...}, "upsertPr": "...", "mergeComplete": "..." }.`);
        return errors;
    }

    // webpieces-disable no-any-unknown -- narrowing the opaque commands section from consumer JSON
    const c = (commands ?? {}) as Record<string, unknown>;

    // pr-gate is required (set mode OFF to opt out). Prefer commands["pr-gate"]; fall back to the
    // legacy top-level block so an un-migrated file still validates its gate config.
    errors.push(...validatePrGateSection(c['pr-gate'] ?? legacyPrGate));

    for (const field of ['upsertPr', 'mergeComplete']) {
        if (field in c && typeof c[field] !== 'string') {
            errors.push(`[commands] "${field}" must be a string (the gated command to run).`);
        }
    }

    return errors;
}
