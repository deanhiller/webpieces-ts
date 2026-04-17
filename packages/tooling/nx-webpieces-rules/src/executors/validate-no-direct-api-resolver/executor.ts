import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { validateNoDirectApiResolver } from '@webpieces/code-rules';

export default async function runExecutor(
    // webpieces-disable no-any-unknown -- options are passed through to code-rules validators
    options: Record<string, unknown>,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return validateNoDirectApiResolver(options, context.root);
}
