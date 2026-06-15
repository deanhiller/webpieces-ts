import type { EditRule, EditContext, Violation } from '../types';
import { Violation as V } from '../types';

const SYMBOL_DI_REGEX = /=\s*Symbol(?:\.for)?\(/;

const ALLOWED_PATHS: RegExp[] = [
    /^libraries\/apis\//,
    /^libraries\/apis-external\//,
    /^packages\/http\/http-api\//,
];

const TEST_PATHS: RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

function isAllowedPath(relativePath: string): boolean {
    return ALLOWED_PATHS.some((re: RegExp) => re.test(relativePath)) ||
        TEST_PATHS.some((re: RegExp) => re.test(relativePath));
}

const noSymbolDiTokensRule: EditRule = {
    name: 'no-symbol-di-tokens',
    description: 'Disallow Symbol() DI tokens outside api(-external) packages. Use @provideSingleton() + inject-by-type instead.',
    scope: 'edit',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: {},
    fixHint: [
        'Do not create a dependency-injection token with Symbol(). Symbol() for DI is allowed in ONLY two places:',
        '  1. INTERNAL apis (libraries/apis/**)          — bind the generated client to its API.',
        '  2. EXTERNAL apis (libraries/apis-external/**)  — bind the impl to its API (impl wraps the external SDK).',
        'EVERYWHERE ELSE, do NOT define a Symbol token and do NOT use @inject(TOKEN).',
        'Instead: annotate the implementation class with @provideSingleton() and inject it by its concrete class TYPE,',
        'e.g.  constructor(private readonly identityResolver: IdentityResolver) {}   // no Symbol, no @inject.',
        'For a swappable default-impl-behind-an-interface, use @provideSingletonAs(TOKEN) — only inside libraries/apis(-external).',
        'If this specific line is a legitimate binding or framework primitive, append:  // webpieces-disable no-symbol-di-tokens -- <reason>',
    ],

    check(ctx: EditContext): readonly Violation[] {
        if (isAllowedPath(ctx.relativePath)) return [];

        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!SYMBOL_DI_REGEX.test(stripped ?? '')) continue;
            const lineNum = i + 1;
            if (ctx.isLineDisabled(lineNum, 'no-symbol-di-tokens')) continue;
            violations.push(new V(
                lineNum,
                ctx.lines[i]?.trim() ?? '',
                'Symbol() used as a DI token. Use @provideSingleton() + inject by concrete class type instead.',
            ));
        }
        return violations;
    },
};

export default noSymbolDiTokensRule;
