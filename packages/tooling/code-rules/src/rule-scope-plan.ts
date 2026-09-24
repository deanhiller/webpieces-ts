import { BaseRuleConfig, FileScope, FileScopeKind, InformAiError, WholeScopeModes } from '@webpieces/rules-config';

import { CodeRulesRunRequest } from './code-rules-run-request';

/** What a debug run is judging, for its banner and its per-project report. Data-only. */
export class DebugTarget {
    constructor(
        readonly rule: string,
        /** The mode webpieces.config.json commits the rule to. */
        readonly committedMode: string,
        /** The mode this run judges at (`--mode`, else the committed one). */
        readonly mode: string,
        /** `--projects` as given, or null for every project. */
        readonly projectNames: readonly string[] | null,
        /** Their repo-relative roots, in the same order, or null. */
        readonly projectRoots: readonly string[] | null,
    ) {}
}

/**
 * The {@link FileScope} each rule runs inside, keyed by config key (a match-rule by its name), plus the
 * debug target when this is a debug run. Bound at the composition root; the engine wraps each rule's
 * run in `diffScope.within(scopes.of(key), …)`. A rule with no entry runs in today's plain diff scope.
 */
export class RuleScopes {
    constructor(
        private readonly byKey: ReadonlyMap<string, FileScope>,
        readonly debugTarget: DebugTarget | null,
    ) {}

    of(key: string): FileScope {
        return this.byKey.get(key) ?? FileScope.DIFF;
    }
}

/**
 * Composition-time planner: turns each rule's COMMITTED config (plus a debug request) into the config
 * the rule actually runs with and the {@link FileScope} it runs inside. This is the one place the
 * whole-scope modes of #1027 are applied to a rule, for every rule at once:
 *
 *   - a DIFF-scoped rule whose mode is MODIFIED_PROJECTS / RUN_EVERY_TIME runs with its most-whole
 *     per-file mode (e.g. NEW_AND_MODIFIED_FILES) inside a widened FileScope — so the rule's own code
 *     never has to know the two modes exist;
 *   - a rule whose mode set has no diff-scoped mode (PROJECT_MODES) keeps its mode untouched — its own
 *     MODIFIED_PROJECTS is its native behaviour, not a widening;
 *   - the debug target additionally takes `--mode`, is restricted to `--projects`, and ignores the two
 *     escape hatches for this run (it is a measurement, not the gate).
 *
 * The committed config object is never mutated: a rule that needs a different mode gets a copy.
 */
export class RuleScopePlanner {
    /**
     * The one rule whose NEW_AND_MODIFIED_FILES is NOT a whole-file judgement, so the generic choice
     * (WholeScopeModes.wholeFileJudgeMode) would silently judge less than the whole file. max-method-lines at
     * NEW_AND_MODIFIED_FILES runs only its modified-methods sub-check, which leaves every NEW method to
     * the new-methods sub-check — and inside a whole scope every method reads as new. Its
     * NEW_AND_MODIFIED_METHODS runs both sub-checks, which is the whole file. Pinned by
     * whole-scope-modes.spec.ts, which fails if this entry is removed.
     */
    private static readonly WHOLE_FILE_JUDGE_OVERRIDES: ReadonlyMap<string, string> = new Map([
        ['max-method-lines', 'NEW_AND_MODIFIED_METHODS'],
    ]);

    private readonly scopes = new Map<string, FileScope>();
    private readonly wholeScope = new WholeScopeModes();
    private target: DebugTarget | null = null;

    constructor(
        private readonly request: CodeRulesRunRequest,
        private readonly projectRoots: readonly string[] | null,
    ) {}

    /** The config `key`'s rule runs with. `modeSet` is the modes its schema accepts. */
    plan<C extends BaseRuleConfig>(key: string, config: C, modeSet: readonly string[]): C {
        const isTarget = this.request.rule === key;
        const committed = config.mode ?? 'OFF';
        const mode = isTarget ? this.targetMode(key, committed, modeSet) : committed;
        const judge = this.wholeScope.isWholeScopeMode(mode) ? this.judgeModeFor(key, modeSet) : null;
        const kind: FileScopeKind = judge !== null && this.wholeScope.isWholeScopeMode(mode) ? mode : 'DIFF';
        const scope = new FileScope(kind, isTarget ? this.projectRoots : null);
        if (!scope.isPlainDiff()) this.scopes.set(key, scope);
        if (isTarget) {
            this.target = new DebugTarget(key, committed, mode, this.request.projects, this.projectRoots);
        }
        if (judge === null && !isTarget) return config;
        const copy = Object.assign(Object.create(Object.getPrototypeOf(config) as object) as C, config);
        const base: BaseRuleConfig = copy;
        base.mode = judge ?? mode;
        if (isTarget) {
            base.turnOffRuleUntilEpoch = 0;
            base.turnOffRuleWhileOnBranch = null;
        }
        return copy;
    }

    /** The scopes planned so far. Throws when a debug run named a rule no `plan` call saw. */
    result(): RuleScopes {
        const rule = this.request.rule;
        if (rule !== null && this.target === null) {
            throw new InformAiError(
                `--rule=${rule} names no code rule and no match-rule in webpieces.config.json. A debug run judges ` +
                    `a rule @webpieces/code-rules runs at build time (the keys under "rules", or a "match-rules" name).`,
            );
        }
        return new RuleScopes(this.scopes, this.target);
    }

    private judgeModeFor(key: string, modeSet: readonly string[]): string | null {
        const generic = this.wholeScope.wholeFileJudgeMode(modeSet);
        return generic === null ? null : (RuleScopePlanner.WHOLE_FILE_JUDGE_OVERRIDES.get(key) ?? generic);
    }

    private targetMode(key: string, committed: string, modeSet: readonly string[]): string {
        const mode = this.request.mode ?? committed;
        if (this.request.mode !== null && !modeSet.includes(mode)) {
            throw new InformAiError(
                `--mode=${mode} is not a mode of ${key}. Its modes: ${modeSet.join(', ')}.`,
            );
        }
        if (mode === 'OFF') {
            throw new InformAiError(
                `${key} is "mode": "OFF" in webpieces.config.json, so a debug run at the committed mode judges ` +
                    `nothing. Pass --mode=<MODE> to judge it at another mode for this run: ${modeSet.filter((m: string) => m !== 'OFF').join(', ')}.`,
            );
        }
        return mode;
    }
}
