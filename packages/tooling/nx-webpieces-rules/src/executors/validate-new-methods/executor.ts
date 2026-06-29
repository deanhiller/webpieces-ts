import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { runNewMethods } from '@webpieces/code-rules';
import { MaxMethodLinesConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: MaxMethodLinesConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return runNewMethods(options, context.root);
}
