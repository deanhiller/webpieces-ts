import { NoCustomCssConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, Option, DisableEscape } from '../fix-hint';

// Edit-time (regex/line) counterpart to the CI code-rule validate-no-custom-css. The hook has no TS
// AST, so the `.ts` side matches the @Component style props by shape; the `.html` side matches inline
// style attributes/bindings. Both are diff-precise via the hook's per-line edit context.
const RE_STYLE_URLS = /(^|\s)styleUrls?\s*:/; // styleUrls: / styleUrl:
const RE_STYLES_ARRAY = /(^|\s)styles\s*:\s*\[/; // styles: [ ... ] (component inline CSS)
const RE_INLINE_STYLE = /(^|\s)style\s*=\s*["']/; // static style="…"
const RE_NG_STYLE = /\[?ngStyle\]?\s*=/; // [ngStyle]="…"
const RE_STYLE_BINDING = /\[style(?:\.[\w.-]+)?\]/; // [style] / [style.width]

const TEST_PATHS: RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

export class NoCustomCssRule extends EditRuleBase<NoCustomCssConfig> {
    constructor(config: NoCustomCssConfig) { super(config, 'no-custom-css'); }

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
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-custom-css -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const allowGlobs = this.config.allowGlobs ?? [];
        if (this.isAllowedPath(ctx.relativePath, allowGlobs)) return [];

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

    private isAllowedPath(relativePath: string, allowGlobs: readonly string[]): boolean {
        if (TEST_PATHS.some((re: RegExp) => re.test(relativePath))) return true;
        return allowGlobs.some((pattern: string) => this.globToRegex(pattern).test(relativePath));
    }

    private globToRegex(pattern: string): RegExp {
        let re = '';
        let i = 0;
        while (i < pattern.length) {
            const ch = pattern[i];
            if (ch === '*') {
                if (pattern[i + 1] === '*') {
                    re += '.*';
                    i += 2;
                    if (pattern[i] === '/') i += 1;
                    continue;
                }
                re += '[^/]*';
                i += 1;
                continue;
            }
            if (ch === '?') {
                re += '[^/]';
                i += 1;
                continue;
            }
            if ('.+^$(){}|[]\\'.includes(ch)) {
                re += '\\' + ch;
                i += 1;
                continue;
            }
            re += ch;
            i += 1;
        }
        return new RegExp('^' + re + '$');
    }
}
