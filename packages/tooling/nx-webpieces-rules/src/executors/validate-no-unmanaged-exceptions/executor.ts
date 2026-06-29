import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoUnmanagedExceptionsValidator } from '@webpieces/code-rules';
import { NoUnmanagedExceptionsConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: NoUnmanagedExceptionsConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoUnmanagedExceptionsValidator(options).run(context.root);
}
