import { NoSymbolDiTokensConfig, RULE_NAMES } from '@webpieces/rules-config';

import type { EditContext, Violation } from '../types';
import { Violation as V } from '../types';
import { EditRuleBase } from '../rule-base';
import { FixHint, Option, DisableEscape } from '../fix-hint';

const SYMBOL_DI_REGEX = /=\s*Symbol(?:\.for)?\(/;

const TEST_PATHS: RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

function globToRegex(pattern: string): RegExp {
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

function isAllowedPath(relativePath: string, allowedPaths: readonly string[]): boolean {
    if (TEST_PATHS.some((re: RegExp) => re.test(relativePath))) return true;
    return allowedPaths.some((pattern: string) => globToRegex(pattern).test(relativePath));
}

export class NoSymbolDiTokensRule extends EditRuleBase<NoSymbolDiTokensConfig> {
    constructor(config: NoSymbolDiTokensConfig) { super(config, 'no-symbol-di-tokens'); }

    readonly description = 'Disallow Symbol() DI tokens outside explicitly configured paths. Use @provideSingleton() + inject-by-type instead.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = { allowedPaths: [] };
    get fixHint(): FixHint {
        return new FixHint(
            'Symbol() used as a DI token — we avoid Symbol DI tokens where we can.',
            'Pick one:',
            [
                new Option('Use @provideSingleton() on the class and inject by type — no Symbol needed.', true),
                new Option('Implement an API interface — import the Symbol from the API definition and use @provideSingletonAs(TOKEN).'),
                new Option('External lib class (DataSource, Anthropic, etc.) — bind<Cls>(Cls).toDynamicValue(...).inSingletonScope() — no Symbol.'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-symbol-di-tokens -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        const allowedPaths = this.config.allowedPaths ?? [];
        if (isAllowedPath(ctx.relativePath, allowedPaths)) return [];

        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!SYMBOL_DI_REGEX.test(stripped ?? '')) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, RULE_NAMES.NO_SYMBOL_DI_TOKENS)) continue;
            violations.push(new V(lineNum, ctx.lines[i]?.trim() ?? ''));
        }
        return violations;
    }
}
