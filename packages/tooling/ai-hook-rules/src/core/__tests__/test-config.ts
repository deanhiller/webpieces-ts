import { builtInRuleNames } from '../rules/index';

export function makeFullConfig(overrides?: Record<string, object>, rulesDir?: string[]): string {
    const rules: Record<string, object> = {};
    for (const name of builtInRuleNames) {
        rules[name] = { mode: 'OFF' };
    }
    if (overrides) {
        Object.assign(rules, overrides);
    }
    return JSON.stringify({ rules, rulesDir: rulesDir ?? [] });
}
