import { FieldDef } from './field-def';
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
    NoEditOnMainConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
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
    'no-edit-on-main': NoEditOnMainConfig.SCHEMA,
    'no-file-import-cycles': NoFileImportCyclesConfig.SCHEMA,
    'runtime-architecture': RuntimeArchitectureConfig.SCHEMA,
    'no-js-files': NoJsFilesConfig.SCHEMA,
    'validate-ts-in-src': ValidateTsInSrcConfig.SCHEMA,
};

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
    let out =
        `[${ruleName}] Not configured in webpieces.config.json. Add this entry to the "rules" section\n` +
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
        `      { "name": "API Changed", "patterns": ["libraries/apis/**", "**/*Api.ts"], "color": "yellow" }\n` +
        `    ]\n` +
        `  }`
    );
}

// webpieces-disable no-any-unknown -- one gate entry from opaque consumer JSON, validated field-by-field
function validateGate(gate: unknown, index: number): string[] {
    if (typeof gate !== 'object' || gate === null) {
        return [`[pr-gate] gates[${index}] must be an object { name, patterns, color, disabled? }.`];
    }
    // webpieces-disable no-any-unknown -- narrowing one opaque gate object from consumer JSON
    const g = gate as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof g['name'] !== 'string') errors.push(`[pr-gate] gates[${index}].name must be a string.`);
    if (!Array.isArray(g['patterns']) || !g['patterns'].every(p => typeof p === 'string'))
        errors.push(`[pr-gate] gates[${index}].patterns must be string[].`);
    if (g['color'] !== undefined && g['color'] !== 'yellow' && g['color'] !== 'red')
        errors.push(`[pr-gate] gates[${index}].color must be "yellow" or "red" (green is implicit when nothing matches).`);
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
            `[pr-gate] Not configured in webpieces.config.json. Add this top-level block ` +
            `(sibling of "rules"; set "mode": "OFF" to opt out):\n\n${prGateExample()}`,
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
            errors.push(`[pr-gate] "gates" must be an array of { name, patterns, color, disabled? }.`);
        } else {
            for (let i = 0; i < gates.length; i += 1) {
                errors.push(...validateGate(gates[i], i));
            }
        }
    }

    return errors;
}
