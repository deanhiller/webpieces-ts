import { BaseRuleConfig } from '@webpieces/rules-sdk';

/** Resolved settings consumed by source contributions; the canonical owner validates their schema. */
export class SourceContributionConfig extends BaseRuleConfig {
    limit?: number;
    disableAllowed?: boolean;
    allowTopLevel?: boolean;
    allowGlobs?: string[];
    /** catch-must-propagate: forwarder / logger callee names a caught error may be handed to whole. */
    forwards?: string[];
}
