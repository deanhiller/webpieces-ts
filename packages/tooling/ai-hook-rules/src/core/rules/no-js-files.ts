import { isPathExcluded, Option } from '@webpieces/rules-config';
import { NoJsFilesConfig } from '../../configs/rule-configs';

import type { FileContext, Violation } from '@webpieces/hook-runtime';
import { Violation as V } from '@webpieces/hook-runtime';
import { FileRuleBase } from '@webpieces/hook-runtime';
import { FixHint } from '@webpieces/hook-runtime';

export class NoJsFilesRule extends FileRuleBase<NoJsFilesConfig> {
    constructor(config: NoJsFilesConfig) {
        super(config, 'no-js-files', 'no-js-files');
    }

    readonly description = 'Disallow writing new .js/.jsx files. Use .ts/.tsx instead.';
    override readonly files = ['**/*.js', '**/*.jsx'];
    override readonly defaultOptions = { allowedPaths: [] };
    readonly fixHint = new FixHint(
        'Writing .js/.jsx files is not allowed. Use .ts/.tsx instead.',
        'Pick one:',
        [
            new Option('Write a .ts or .tsx file instead of .js/.jsx.', true),
            new Option(
                'If this path must be .js (generated/legacy), add it to no-js-files.allowedPaths in {configFile}',
            ),
        ],
    );

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.tool !== 'Write') return [];

        const allowedPaths = this.config.allowedPaths ?? [];

        if (isPathExcluded(ctx.relativePath, allowedPaths)) return [];

        return [new V(1, ctx.relativePath)];
    }
}
