// Seeding: what a rule's webpieces.config.json entry should look like when nothing has configured it
// yet. Split out of validate-config.ts (700-line cap). This is the SINGLE source of truth shared by the
// validator's copy-paste snippet (rolloutTip), the installer (ai-hook-rules setup.seedRule) and fault Y's
// deny — so a seeded config can never contradict the advice printed beside it.
import { FieldDef } from './field-def';
import { RULE_SCHEMAS } from './rule-schemas';
import { defaultRules } from './default-rules';

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

// The ONE place that decides what mode a rule should arrive as. Every consumer of that decision —
// the validator's copy-paste snippet (rolloutTip in validate-config.ts), the installer's seeding, and the fault-`Y` deny in
// ai-hook-rules — calls this, so a seeded config can never contradict the advice printed beside it.
// Precedence: narrowest gradual mode the rule supports → ON → RUN_EVERY_TIME → OFF (a rule offering
// none of those has nothing else it can be).
// webpieces-disable no-function-outside-class -- sibling of the module-scope schema helpers in this file
export function recommendedSeedModeFor(modes: readonly string[]): string {
    const gradual = GRADUAL_MODE_PREFERENCE.find((m: string) => modes.includes(m));
    if (gradual) return gradual;
    if (modes.includes('ON')) return 'ON';
    if (modes.includes('RUN_EVERY_TIME')) return 'RUN_EVERY_TIME';
    return 'OFF';
}

/**
 * The mode a fresh/migrated `webpieces.config.json` entry for `ruleName` should be seeded with.
 * Unknown rule names (custom rules from `rulesDir`) fall back to 'OFF' — we have no schema to know
 * which modes they accept.
 */
// webpieces-disable no-function-outside-class -- sibling of the module-scope schema helpers in this file
export function recommendedSeedMode(ruleName: string): string {
    const schema = RULE_SCHEMAS[ruleName];
    if (!schema) return 'OFF';
    return recommendedSeedModeFor(schema['mode']?.enumValues ?? []);
}

// The value a seeded entry gets for ONE required field. Order matters and is deliberate:
//   1. the two universal escape hatches — always their "active" state (0 / null), never a placeholder;
//   2. `mode` — the shared recommendation (see recommendedSeedMode);
//   3. the framework's documented default for that rule (defaultRules) — the value the rule's own
//      config class commits to, e.g. max-file-lines.limit: 900, branch-creation-guard
//      .autoReapMergedBranches: true (reaping is on by default — see default-rules.ts for why);
//   4. a conservative fallback by type — null if the field accepts null, false for boolean, [] for
//      string[], the first enum value for an enum, '' / 0 otherwise. Reaching step 4 for a NEW field
//      means the rule forgot to give defaultRules an entry, which the seed-validates-clean spec in
//      ai-hook-rules/src/bin/setup.spec.ts turns into a build failure if the fallback is not valid.
// webpieces-disable no-any-unknown -- a config field value is opaque JSON by construction
// webpieces-disable no-function-outside-class -- sibling of the module-scope schema helpers in this file
function seedFieldValue(ruleName: string, key: string, def: FieldDef): unknown {
    if (key === 'turnOffRuleUntilEpoch') return 0;
    if (key === 'turnOffRuleWhileOnBranch') return null;
    if (key === 'mode') return recommendedSeedModeFor(def.enumValues ?? []);

    const documented = defaultRules[ruleName]?.[key];
    if (documented !== undefined) return documented;

    if (def.nullable) return null;
    if (def.type === 'boolean') return false;
    if (def.type === 'string[]') return [];
    if (def.enumValues && def.enumValues.length > 0) return def.enumValues[0];
    return def.type === 'number' ? 0 : '';
}

/**
 * The COMPLETE `webpieces.config.json` entry for `ruleName` — recommended mode, both escape hatches,
 * and a value for every other schema-REQUIRED field.
 *
 * Emitting only mode+hatches is what let `wp-install-ai-hooks` write a config the loader then
 * rejected (`[branch-creation-guard] Missing required field "autoReapMergedBranches"`), so the
 * installer and the validator read the SAME schema here. Unknown rule names (custom rules from
 * `rulesDir`) get the minimal entry — we have no schema to enumerate their required fields.
 */
// webpieces-disable no-any-unknown -- a config entry is opaque JSON by construction
// webpieces-disable no-function-outside-class -- sibling of the module-scope schema helpers in this file
export function seedEntryForRule(ruleName: string): Record<string, unknown> {
    const schema = RULE_SCHEMAS[ruleName];
    const entry: Record<string, unknown> = {
        mode: recommendedSeedMode(ruleName), turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null,
    };
    if (!schema) return entry;
    for (const key of Object.keys(schema)) {
        if (schema[key].optional) continue;
        entry[key] = seedFieldValue(ruleName, key, schema[key]);
    }
    return entry;
}


/** True when `mode` is one of the gradual (change-scoped) modes — used to decide whether to print the rollout prose. */
// webpieces-disable no-function-outside-class -- sibling of the seeding helpers in this file
export function isGradualMode(mode: string): boolean {
    return GRADUAL_MODE_PREFERENCE.includes(mode);
}
