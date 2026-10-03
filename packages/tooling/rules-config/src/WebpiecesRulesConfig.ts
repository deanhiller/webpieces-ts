import { BaseRuleConfig } from '@webpieces/rules-sdk';

/** The framework carries validated values; concrete packs supply and interpret their own types. */
export class WebpiecesRulesConfig {
    [configKey: string]: BaseRuleConfig | string[] | undefined;
    rulesDir?: string[];
}
