import { FieldDef } from './field-def';
import { sectionForRule, isHookGuard } from './sections';
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
    NoShellSubstitutionConfig,
    BranchCreationGuardConfig,
    PrCreationGuardConfig,
    MergeInProgressGuardConfig,
    PrMergeCleanupConfig,
    NoDirectMainUpdateConfig,
    FeatureBranchGuardConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NxWiringConfig,
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
    'no-shell-substitution': NoShellSubstitutionConfig.SCHEMA,
    'branch-creation-guard': BranchCreationGuardConfig.SCHEMA,
    'pr-creation-guard': PrCreationGuardConfig.SCHEMA,
    'merge-in-progress-guard': MergeInProgressGuardConfig.SCHEMA,
    'pr-merge-cleanup': PrMergeCleanupConfig.SCHEMA,
    'no-direct-main-update': NoDirectMainUpdateConfig.SCHEMA,
    'feature-branch-guard': FeatureBranchGuardConfig.SCHEMA,
    'no-file-import-cycles': NoFileImportCyclesConfig.SCHEMA,
    'runtime-architecture': RuntimeArchitectureConfig.SCHEMA,
    'nx-wiring': NxWiringConfig.SCHEMA,
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
    return out;
}

// webpieces-disable no-any-unknown -- rawRules values are opaque JSON; each field is validated individually
export function validateWebpiecesConfig(
    rawRules: Record<string, Record<string, unknown>>,
): string[] {
    const errors: string[] = [];

    // Check field-level correctness for rules that are present
    for (const [ruleName, entry] of Object.entries(rawRules)) {
        const schema = RULE_SCHEMAS[ruleName];
        if (!schema) continue; // custom/unknown rule — no schema to validate against
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
