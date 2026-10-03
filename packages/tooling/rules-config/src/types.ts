// webpieces-disable no-any-unknown -- rule options are opaque at framework level; each consumer casts internally
export type RuleOptions = Record<string, unknown>;

/**
 * One validated owner entry, with only owner-declared optional tuning resolved.
 *
 * `options` contains the raw option bag (mode, limit, disableAllowed,
 * turnOffRuleUntilEpoch, enforcePaths, etc). Consumers extract the
 * fields they understand and ignore the rest.
 *
 * On/off is driven entirely by `mode`: a rule is OFF only when explicitly
 * set to `mode: "OFF"`. Every configured entry has a schema-required mode. For code-rules, `mode` doubles as the scope selector
 * (e.g. "NEW_AND_MODIFIED_CODE", "NEW_AND_MODIFIED_METHODS"); for simple on/off
 * rules it is just "ON"/"OFF". (The legacy `enabled` boolean has been
 * removed in favor of this single, more flexible switch.)
 */
export class ResolvedRuleConfig {
    readonly options: RuleOptions;

    constructor(options: RuleOptions) {
        this.options = options;
    }

    /** Raw mode string from the option bag ("ON" | "OFF" | scope value), if present. */
    get mode(): string | undefined {
        const m = this.options['mode'];
        return typeof m === 'string' ? m : undefined;
    }

    /** A rule is off only when explicitly `mode: "OFF"`. The loader rejects an absent mode. */
    get isOff(): boolean {
        return this.mode === 'OFF';
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
    readonly userConfiguredRuleNames: ReadonlySet<string>;
    readonly configPath: string | null;

    constructor(
        rules: Map<string, ResolvedRuleConfig>,
        userConfiguredRuleNames: ReadonlySet<string>,
        configPath: string | null,
    ) {
        this.rules = rules;
        this.userConfiguredRuleNames = userConfiguredRuleNames;
        this.configPath = configPath;
    }
}
