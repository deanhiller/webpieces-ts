import { DisableEscape, FileContext, FileRuleBase, FixHint, Violation } from '@webpieces/hook-runtime';
import { LocalRule, LocalRuleConfig } from './local-rule';
import { LocalRuleJudge, LocalRuleVerdict } from './local-rule-judge';

/**
 * A local rule at Write/Edit time: it judges the PROPOSED file — the whole post-edit text that
 * `ProposedFile` projects in memory — through the same {@link LocalRuleJudge} the build gate calls.
 *
 * Under NEW_AND_MODIFIED_CODE only a finding spanning a line this edit changed is refused; every other
 * active mode judges the whole proposed file. OFF, the epoch and branch switches and `excludePaths` are
 * applied by the hook runtime before `check` is ever called (`ConfiguredHookPolicy`).
 */
export class LocalSourceHookPolicy extends FileRuleBase<LocalRuleConfig> {
    readonly description: string;
    override readonly files: readonly string[];
    readonly fixHint: FixHint;
    private readonly judge: LocalRuleJudge;

    constructor(config: LocalRuleConfig, rule: LocalRule) {
        super(config, rule.id, rule.id);
        this.description = rule.description;
        this.files = rule.files;
        this.judge = new LocalRuleJudge(rule);
        this.fixHint = new FixHint(
            rule.description,
            'Fix it — pick one:',
            rule.cures,
            new DisableEscape(true, this.judge.disableComment()),
        );
    }

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.proposedFile === null) return [];
        const content = ctx.proposedFile.read();
        const changed = this.config.mode === 'NEW_AND_MODIFIED_CODE' ? content.changedLines() : undefined;
        return this.judge
            .judge(ctx.relativePath, content.text, this.config, changed)
            .map((verdict: LocalRuleVerdict) => new Violation(verdict.line, verdict.snippet, verdict.message));
    }
}
