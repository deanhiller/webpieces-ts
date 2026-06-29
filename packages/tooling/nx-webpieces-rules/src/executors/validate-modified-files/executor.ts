import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { MaxFileLinesValidator } from '@webpieces/code-rules';
import { MaxFileLinesConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: MaxFileLinesConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new MaxFileLinesValidator(options).run(context.root);
}
