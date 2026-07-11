import { MatchRuleConfig } from '@webpieces/rules-config';

/**
 * The resolved repo/workspace root, bound at bootstrap (toConstantValue) and injected where the
 * engine runs validators. A tiny holder class so it is a normal inject-by-type DI node, not a raw
 * string threaded through constructors.
 */
export class WorkspaceRoot {
    constructor(readonly path: string) {}
}

/**
 * The client-authored match-rules (one validator gets built per entry). Bound at bootstrap so the
 * engine can construct a MatchRulesValidator per config without the config classes leaking into
 * every constructor.
 */
export class MatchRulesHolder {
    constructor(readonly rules: readonly MatchRuleConfig[]) {}
}
