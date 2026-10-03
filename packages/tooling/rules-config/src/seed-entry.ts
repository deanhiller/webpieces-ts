import { InformAiError } from '@webpieces/tooling-common';
import { ConfigObject } from '@webpieces/rules-sdk';
import { RulePackRegistry } from './rule-pack-registry';

const GRADUAL_MODE_PREFERENCE = [
    'NEW_AND_MODIFIED_CODE',
    'NEW_AND_MODIFIED_METHODS',
    'MODIFIED_CLASS',
    'NEW_METHODS',
    'NEW_AND_MODIFIED_FILES',
    'MODIFIED_PROJECTS',
    // Same granularity as MODIFIED_PROJECTS, from the other direction: the projects nx's diff makes
    // affected. Listed after it so a rule offering both keeps its existing recommendation (#1017).
    'AFFECTED_PROJECT',
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

/** Recommendations are owner-authored file-writing data, never runtime defaults. */
// webpieces-disable no-function-outside-class -- pure registry projection
export function recommendedSeedMode(ruleName: string, registry: RulePackRegistry): string {
    return String(seedEntryForRule(ruleName, registry)['mode']);
}
// webpieces-disable no-function-outside-class -- pure registry projection
export function seedEntryForRule(ruleName: string, registry: RulePackRegistry): ConfigObject {
    if (registry.hasRule(ruleName)) return registry.seedFor(ruleName);
    if (registry.isSafeguard(ruleName))
        throw new InformAiError(
            `${ruleName} is a safeguard with no configurable seed. Remove its config entry.`,
        );
    throw new InformAiError(
        `No selected owner supplies a seed for ${ruleName}. Declare its client rule pack with a schema and recommended seed; sync never invents settings for unknown policies.`,
    );
}

/** True when `mode` is one of the gradual (change-scoped) modes — used to decide whether to print the rollout prose. */
// webpieces-disable no-function-outside-class -- sibling of the seeding helpers in this file
export function isGradualMode(mode: string): boolean {
    return GRADUAL_MODE_PREFERENCE.includes(mode);
}
