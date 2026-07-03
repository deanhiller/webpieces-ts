import { MaxFileLinesConfig, writeTemplateIfMissing } from '@webpieces/rules-config';

import type { FileContext, Violation } from '../types';
import { Violation as V } from '../types';
import { FileRuleBase } from '../rule-base';
import { FixHint, DisableEscape } from '../fix-hint';

const DEFAULT_LIMIT = 900;
const INSTRUCT_FILE = 'webpieces.filesize.md';

export class MaxFileLinesRule extends FileRuleBase<MaxFileLinesConfig> {
    constructor(config: MaxFileLinesConfig) { super(config, 'max-file-lines'); }

    readonly description = 'Cap file length at a configured line limit.';
    override readonly files = ['**/*.ts', '**/*.tsx'];
    override readonly defaultOptions = { limit: DEFAULT_LIMIT };
    get fixHint(): FixHint {
        return new FixHint(
            'File exceeds the max-file-lines limit.',
            'READ .webpieces/instruct-ai/webpieces.filesize.md and refactor to reduce the file size.',
            [],
            new DisableEscape(this.config.disableAllowed ?? true, '// eslint-disable-next-line @webpieces/max-file-lines  (also suppresses the eslint rule)'),
        );
    }

    check(ctx: FileContext): readonly Violation[] {
        const limit = this.config.limit ?? DEFAULT_LIMIT;
        if (ctx.projectedFileLines <= limit) return [];
        writeTemplateIfMissing(ctx.workspaceRoot, INSTRUCT_FILE);
        return [new V(
            1,
            `(projected ${String(ctx.projectedFileLines)} lines)`,
            `File will be ${String(ctx.projectedFileLines)} lines, exceeding the ${String(limit)}-line limit. See .webpieces/instruct-ai/webpieces.filesize.md for detailed refactoring instructions.`,
        )];
    }
}
