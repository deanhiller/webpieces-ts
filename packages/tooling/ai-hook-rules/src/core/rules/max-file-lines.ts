import type { FileRule, FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { writeTemplateIfMissing } from '@webpieces/rules-config';

const DEFAULT_LIMIT = 900;
const INSTRUCT_FILE = 'webpieces.filesize.md';

const maxFileLinesRule: FileRule = {
    name: 'max-file-lines',
    description: 'Cap file length at a configured line limit.',
    scope: 'file',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: { limit: DEFAULT_LIMIT },
    fixHint: [
        'READ .webpieces/instruct-ai/webpieces.filesize.md for step-by-step refactoring guidance.',
        '// eslint-disable-next-line @webpieces/max-file-lines  (also suppresses the eslint rule)',
    ],

    check(ctx: FileContext): readonly Violation[] {
        const limit = typeof ctx.options['limit'] === 'number'
            ? ctx.options['limit'] as number
            : DEFAULT_LIMIT;
        if (ctx.projectedFileLines <= limit) return [];
        writeTemplateIfMissing(ctx.workspaceRoot, INSTRUCT_FILE);
        return [new V(
            1,
            `(projected ${String(ctx.projectedFileLines)} lines)`,
            `File will be ${String(ctx.projectedFileLines)} lines, exceeding the ${String(limit)}-line limit. See .webpieces/instruct-ai/webpieces.filesize.md for detailed refactoring instructions.`,
        )];
    },
};

export default maxFileLinesRule;
