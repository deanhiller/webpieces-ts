import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { runModifiedMethods } from '@webpieces/code-rules';
import { MaxMethodLinesConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: MaxMethodLinesConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return runModifiedMethods(options, context.root);
}
