import { SourceContributionConfig } from '../source-contribution-config';
import { TypeKeywordSite } from '@webpieces/tooling-common/type-keywords';
import { sourceAnalysis } from '../source-analysis';
import { isPathExcluded, GENERATED_CODE_PATHS } from '@webpieces/rules-config';
import { FileContext, Violation, FileRuleBase, FixHint, DisableEscape, createIsLineDisabled } from '@webpieces/hook-runtime';

/** Refuse both escape types before writing, using the same syntax detector as the build. */
export class NoAnyUnknownRule extends FileRuleBase<SourceContributionConfig> {
    constructor(config: SourceContributionConfig) { super(config, 'no-any-unknown', 'no-any-unknown'); }

    readonly description = 'Disallow both `any` and `unknown` type keywords. Think through the data and use an actual concrete type.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    get fixHint(): FixHint {
        return new FixHint(
            '`any` and `unknown` hide the actual data contract.',
            'Understand the value and reuse its concrete type, or define a precise class, interface or type describing the actual data. Do not replace `any` with `unknown` or hide it behind a cast.',
            [],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-any-unknown -- <one-line reason>'),
        );
    }

    check(ctx: FileContext): readonly Violation[] {
        if (isPathExcluded(ctx.relativePath, [...GENERATED_CODE_PATHS, ...(this.config.allowedPaths ?? [])])) return [];
        const syntax = sourceAnalysis.forFile(ctx);
        const proposed = syntax.content;
        const changed = proposed.changedLines();
        const lineScoped = this.config.mode === 'NEW_AND_MODIFIED_CODE';
        const disabled = createIsLineDisabled(proposed.text);
        const lines = proposed.text.split('\n');
        return syntax.proposed.keywords()
            .filter((site: TypeKeywordSite): boolean => !site.catchVariable && (!lineScoped || changed.has(site.line))
                && !(this.config.disableAllowed !== false && disabled(site.line, this.name)))
            .map((site: TypeKeywordSite): Violation => new Violation(site.line, lines[site.line - 1].trim(),
                `\`${site.keyword}\` is not an actual data type. Use the concrete type of this value.`));
    }
}
