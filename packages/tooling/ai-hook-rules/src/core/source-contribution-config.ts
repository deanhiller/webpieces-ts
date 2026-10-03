import { BaseRuleConfig } from '@webpieces/rules-sdk';

/** Resolved settings consumed by source contributions; the canonical owner validates their schema. */
export class SourceContributionConfig extends BaseRuleConfig {
    limit?: number;
    disableAllowed?: boolean;
    allowTopLevel?: boolean;
    allowedPaths?: string[];
    allowGlobs?: string[];
}
