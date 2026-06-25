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
        '(PREFERRED) Use @provideSingleton() on the class and inject that class directly — no Symbol needed.',
        'Interface+impl pair (e.g. FirestoreApi/FirestoreImpl): co-locate the Symbol with the Api file and add // webpieces-disable no-symbol-di-tokens -- <reason>',
        'External lib creating a class needing binding: put Symbol in a symbols file and add // webpieces-disable no-symbol-di-tokens -- <reason> on each one.',
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
                'Symbol() used as a DI token. Mostly we avoid Symbol if we can — see fix options below.',
            ));
        }
        return violations;
    },
};

export default noSymbolDiTokensRule;
