/**
 * What ONE code-rules run was asked to do (#1027). Data-only.
 *
 * Every field undefined is the gate: every configured rule, at its committed mode, over the diff. Any
 * field set makes it a DEBUG run — exactly one rule (`rule`, required then), optionally at another mode
 * (`mode`, e.g. RUN_EVERY_TIME) and/or restricted to named nx projects (`projects`) — with NOTHING
 * written to disk. `wp-validate-code --rule=… --mode=… --projects=a,b` and
 * `nx run architecture:validate-code --rule=… --mode=… --projects=a,b` both build one of these.
 */
export class CodeRulesRunRequest {
    constructor(
        readonly rule: string | undefined,
        readonly mode: string | undefined,
        readonly projects: readonly string[] | undefined,
    ) {}

    /** True when any debug field was passed. */
    isDebug(): boolean {
        return this.rule !== undefined || this.mode !== undefined || this.projects !== undefined;
    }
}

/**
 * Which rules the engine runs, bound at the composition root: `undefined` for the gate (every active
 * rule), one rule name for a debug run. Data-only.
 */
export class RuleSelection {
    constructor(readonly onlyRule: string | undefined) {}

    includes(ruleName: string): boolean {
        return this.onlyRule === undefined || this.onlyRule === ruleName;
    }
}

/**
 * Builds a {@link CodeRulesRunRequest} from raw flag values. nx hands `--projects=a,b` over as a string
 * or an array depending on how it was typed, and the bin hands over strings, so the normalisation lives
 * here once: `a,b` / `a, b` / `['a','b']` / `['a,b']` all become `['a','b']`, and a blank value is "not
 * passed".
 */
export class RunRequestParser {
    parse(rule: string | undefined, mode: string | undefined, projects: string | readonly string[] | undefined): CodeRulesRunRequest {
        return new CodeRulesRunRequest(this.blankToUndefined(rule), this.blankToUndefined(mode), this.splitProjects(projects));
    }

    private splitProjects(raw: string | readonly string[] | undefined): string[] | undefined {
        if (raw === undefined) return undefined;
        const parts = (typeof raw === 'string' ? [raw] : [...raw])
            .flatMap((each: string) => each.split(','))
            .map((each: string) => each.trim())
            .filter((each: string) => each.length > 0);
        return parts.length === 0 ? undefined : parts;
    }

    private blankToUndefined(raw: string | undefined): string | undefined {
        return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
    }
}
