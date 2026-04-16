// webpieces-disable no-any-unknown -- rule options are opaque at framework level; each consumer casts internally
export type RuleOptions = Record<string, unknown>;

/**
 * One rule entry from webpieces.config.json, merged with built-in defaults.
 *
 * `options` contains the raw option bag (limit, mode, disableAllowed,
 * ignoreModifiedUntilEpoch, enforcePaths, etc). Consumers extract the
 * fields they understand and ignore the rest.
 */
export class ResolvedRuleConfig {
    readonly enabled: boolean;
    readonly options: RuleOptions;

    constructor(enabled: boolean, options: RuleOptions) {
        this.enabled = enabled;
        this.options = options;
    }
}

/**
 * The fully-resolved workspace configuration: every rule known to the
 * workspace (built-in + consumer overrides) keyed by its canonical
 * kebab-case name.
 *
 * `configPath` is null when no webpieces.config.json was found (loaders
 * should treat that as "no validation configured").
 */
export class ResolvedConfig {
    readonly rules: Map<string, ResolvedRuleConfig>;
    readonly rulesDir: readonly string[];
    readonly configPath: string | null;

    constructor(
        rules: Map<string, ResolvedRuleConfig>,
        rulesDir: readonly string[],
        configPath: string | null,
    ) {
        this.rules = rules;
        this.rulesDir = rulesDir;
        this.configPath = configPath;
    }
}
