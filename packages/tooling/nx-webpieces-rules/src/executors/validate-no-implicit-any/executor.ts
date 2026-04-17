import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { validateNoImplicitAny } from '@webpieces/code-rules';

export default async function runExecutor(
    // webpieces-disable no-any-unknown -- options are passed through to code-rules validators
    options: Record<string, unknown>,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return validateNoImplicitAny(options, context.root);
}
