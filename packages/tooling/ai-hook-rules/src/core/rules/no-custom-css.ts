import { NoCustomCssConfig, NoCustomCssScope, RULE_NAMES, Option } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, DisableEscape } from '../fix-hint';

// Edit-time (regex/line) counterpart to the CI code-rule validate-no-custom-css. The hook has no TS
// AST, so the `.ts` side matches the @Component style props by shape; the `.html` side matches inline
// style attributes/bindings. Both are diff-precise via the hook's per-line edit context.
const RE_STYLE_URLS = /(^|\s)styleUrls?\s*:/; // styleUrls: / styleUrl:
const RE_STYLES_ARRAY = /(^|\s)styles\s*:\s*\[/; // styles: [ ... ] (component inline CSS)
const RE_INLINE_STYLE = /(^|\s)style\s*=\s*["']/; // static style="…"
const RE_NG_STYLE = /\[?ngStyle\]?\s*=/; // [ngStyle]="…"
const RE_STYLE_BINDING = /\[style(?:\.[\w.-]+)?\]/; // [style] / [style.width]

export class NoCustomCssRule extends EditRuleBase<NoCustomCssConfig> {
    // The SAME exemption the CI validator narrows its changed-file set with. Shared, because a second copy
    // of this predicate is how `allowGlobs` came to be honoured here and ignored there.
    private readonly pathScope: NoCustomCssScope;

    constructor(config: NoCustomCssConfig) {
        super(config, 'no-custom-css', 'no-custom-css');
        this.pathScope = new NoCustomCssScope(config);
    }

    readonly description =
        'Ban hand-written CSS in Angular (styles/styleUrls in @Component, inline style=, [style.x], [ngStyle]) — style with Tailwind utility classes.';
    override readonly files = ['**/*.ts', '**/*.tsx', '**/*.html'];
    override readonly defaultOptions = { allowGlobs: [] };

    get fixHint(): FixHint {
        return new FixHint(
            'Custom CSS bypasses Tailwind-first styling.',
            'Pick one:',
            [
                new Option('Delete the CSS and use Tailwind utility classes (flex, grid, gap-4, text-red-600).', true),
                new Option('Need a specific value? Use an arbitrary-value class: w-[240px], bg-[#fffde7], grid-cols-[2fr_2fr_48px].'),
                new Option('Dynamic on/off? Prefer [class.x]="cond" over a style binding.'),
                new Option('Whole tree not yours to restyle (a vendored kit, a generated artifact)? Add a glob to no-custom-css.allowGlobs in webpieces.config.json — it exempts the path in the editor and in CI alike.'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-custom-css -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        if (this.pathScope.isExempt(ctx.relativePath)) return [];

        const isHtml = ctx.relativePath.endsWith('.html');
        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const detail = this.detailForLine(ctx.strippedLines[i] ?? '', isHtml);
            if (!detail) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.NO_CUSTOM_CSS)) continue;
            violations.push(new V(lineNum, `${detail}: ${ctx.lines[i]?.trim() ?? ''}`));
        }
        return violations;
    }

    /** The banned-pattern label for a line, or '' when clean. Branches on the file being a template. */
    private detailForLine(line: string, isHtml: boolean): string {
        if (isHtml) {
            if (RE_NG_STYLE.test(line)) return 'inline `[ngStyle]`';
            if (RE_STYLE_BINDING.test(line)) return 'inline `[style.x]` binding';
            if (RE_INLINE_STYLE.test(line)) return 'inline `style=` attribute';
            return '';
        }
        if (RE_STYLE_URLS.test(line)) return '`styleUrls`/`styleUrl` in @Component';
        if (RE_STYLES_ARRAY.test(line)) return '`styles` block in @Component';
        return '';
    }
}
