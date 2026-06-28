import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

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

const noSymbolDiTokensRule: EditRule = {
    name: 'no-symbol-di-tokens',
    description: 'Disallow Symbol() DI tokens outside explicitly configured paths. Use @provideSingleton() + inject-by-type instead.',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: { allowedPaths: [] },
    fixHint: [
        'Option 1: Use @provideSingleton() on the class and inject by type — no Symbol needed.',
        'Option 2: Implement an API interface — import the Symbol from the API definition and use @provideSingletonAs(TOKEN).',
        'Option 3: External lib class (DataSource, Anthropic, etc.) — bind<Cls>(Cls).toDynamicValue(...).inSingletonScope() — no Symbol.',
        'Option 4 (last resort): // webpieces-disable no-symbol-di-tokens -- <reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        const allowedPaths = (ctx.options['allowedPaths'] as string[] | undefined) ?? [];
        if (isAllowedPath(ctx.relativePath, allowedPaths)) return [];

        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!SYMBOL_DI_REGEX.test(stripped ?? '')) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-symbol-di-tokens')) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i]?.trim() ?? '',
                'Symbol() used as a DI token. Mostly we avoid Symbol if we can — see fix options below.',
            ));
        }
        return violations;
    },
};

export default noSymbolDiTokensRule;
