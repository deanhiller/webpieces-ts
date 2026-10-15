import { SourceContributionConfig } from "../source-contribution-config";
import { Option } from "@webpieces/rules-config";

import type { EditContext, Violation } from '@webpieces/hook-runtime';
import { Violation as V } from '@webpieces/hook-runtime';
import { EditRuleBase } from '@webpieces/hook-runtime';
import { FixHint, DisableEscape } from '@webpieces/hook-runtime';

const SYMBOL_DI_REGEX = /=\s*Symbol(?:\.for)?\(/;

const TEST_PATHS: RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

// webpieces-disable no-function-outside-class -- leaf predicate over one path, beside the TEST_PATHS it reads
function isTestPath(relativePath: string): boolean {
    // Configured trees (this rule's excludePaths, the top-level one) are dropped by the engine (#1253).
    return TEST_PATHS.some((re: RegExp) => re.test(relativePath));
}

export class NoSymbolDiTokensRule extends EditRuleBase<SourceContributionConfig> {
    constructor(config: SourceContributionConfig) { super(config, 'no-symbol-di-tokens', 'no-symbol-di-tokens'); }

    readonly description = 'Disallow Symbol() DI tokens outside explicitly configured paths. Use @injectable(bindingScopeValues.Singleton) + inject-by-type instead.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = {};
    get fixHint(): FixHint {
        return new FixHint(
            'Symbol() used as a DI token — we avoid Symbol DI tokens where we can.',
            'Pick one:',
            [
                new Option('Use @injectable(bindingScopeValues.Singleton) on the class and inject by type — no Symbol needed.', true),
                new Option('Implement an API interface — import the Symbol from the API definition and use @provideSingletonDefaultForApi(TOKEN).'),
                new Option('External lib class (DataSource, Anthropic, etc.) — bind<Cls>(Cls).toDynamicValue(...).inSingletonScope() — no Symbol.'),
            ],
            new DisableEscape(this.config.disableAllowed ?? true, '// webpieces-disable no-symbol-di-tokens -- <reason>'),
        );
    }

    check(ctx: EditContext): readonly Violation[] {
        if (isTestPath(ctx.relativePath)) return [];

        const disableAllowed = this.config.disableAllowed ?? true;
        const violations: V[] = [];
        for (let i = 0; i < ctx.strippedLines.length; i += 1) {
            const stripped = ctx.strippedLines[i];
            if (!SYMBOL_DI_REGEX.test(stripped ?? '')) continue;
            const lineNum = i + 1;
            if (disableAllowed && ctx.isLineDisabled(lineNum, "no-symbol-di-tokens")) continue;
            violations.push(new V(lineNum, ctx.lines[i]?.trim() ?? ''));
        }
        return violations;
    }
}
