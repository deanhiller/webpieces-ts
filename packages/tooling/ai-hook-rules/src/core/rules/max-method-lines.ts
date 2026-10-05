import { MethodLineSite } from '@webpieces/tooling-common/method-lines';
import { MethodLinePolicy } from '@webpieces/rules-config/method-line-policy';
import { sourceAnalysis } from '../source-analysis';
import { isPathExcluded, GENERATED_CODE_PATHS } from '@webpieces/rules-config';
import { FileContext, FileRuleBase, Violation, FixHint, DisableEscape } from '@webpieces/hook-runtime';
import { SourceContributionConfig } from '../source-contribution-config';

/** Measure affected complete methods before allowing an AI write. */
export class MaxMethodLinesRule extends FileRuleBase<SourceContributionConfig> {
    constructor(config: SourceContributionConfig) { super(config, 'max-method-lines', 'max-method-lines'); }

    readonly description = 'Keep new and modified methods within the configured physical line limit.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    get fixHint(): FixHint {
        return new FixHint('Method exceeds the max-method-lines limit.',
            'Split the responsibilities into smaller methods or classes with concrete inputs and return types.', [],
            new DisableEscape(this.config.disableAllowed === true, '// webpieces-disable max-lines-modified yyyy/mm/dd -- <reason>'));
    }

    check(ctx: FileContext): readonly Violation[] {
        if (isPathExcluded(ctx.relativePath, [...GENERATED_CODE_PATHS, ...(this.config.allowedPaths ?? [])])) return [];
        const syntax = sourceAnalysis.forFile(ctx);
        const proposed = syntax.content;
        const original = syntax.original().methods();
        const methods = syntax.proposed.methods();
        const changed = proposed.changedLines();
        const lines = proposed.text.split('\n');
        const policy = new MethodLinePolicy();
        const limit = this.config.limit ?? 80;
        return methods.filter((method: MethodLineSite): boolean => {
            if (method.lines <= limit) return false;
            const isNew = !original.some((before: MethodLineSite): boolean => before.key === method.key);
            if (this.config.mode === 'NEW_METHODS' && !isNew) return false;
            if (this.config.mode !== 'NEW_AND_MODIFIED_FILES'
                && !this.isChanged(method, original, changed)) return false;
            return !policy.permits(lines, method.line, isNew, this.config.disableAllowed === true, this.config.mode !== 'NEW_METHODS');
        }).map((method: MethodLineSite): Violation => new Violation(method.line, method.name,
            `${method.name} will be ${method.lines} lines, exceeding the ${limit}-line limit. Split its responsibilities into smaller typed methods or classes.`));
    }

    private isChanged(method: MethodLineSite, original: readonly MethodLineSite[], changed: ReadonlySet<number>): boolean {
        // Comparing unchanged syntax protects legacy methods during complete writes and line shifts.
        if (original.some((before: MethodLineSite): boolean => before.key === method.key
            && before.node.getText() === method.node.getText())) return false;
        for (let line = method.line; line <= method.endLine; line++) if (changed.has(line)) return true;
        return false;
    }
}
