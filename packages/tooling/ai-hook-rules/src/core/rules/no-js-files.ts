import { isPathExcluded } from '@webpieces/rules-config';

import type { FileRule, FileContext, Violation } from '../types';
import { Violation as V } from '../types';

const noJsFiles: FileRule = {
    name: 'no-js-files',
    description: 'Disallow writing new .js/.jsx files. Use .ts/.tsx instead.',
    scope: 'file',
    files: ['**/*.js', '**/*.jsx'],
    defaultOptions: {
        allowedPaths: [],
    },
    fixHint: [
        'Write a .ts or .tsx file instead of .js/.jsx.',
        'If this path must be .js (e.g. a generated or legacy file), add it to no-js-files.allowedPaths in webpieces.config.json',
    ],

    check(ctx: FileContext): readonly Violation[] {
        if (ctx.tool !== 'Write') return [];

        const allowedPaths = Array.isArray(ctx.options['allowedPaths'])
            ? ctx.options['allowedPaths'] as string[]
            : [];

        if (isPathExcluded(ctx.relativePath, allowedPaths)) return [];

        return [new V(1, ctx.relativePath, 'Writing .js/.jsx files is not allowed. Use .ts/.tsx instead.')];
    },
};

export default noJsFiles;
