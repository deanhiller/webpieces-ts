import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { validateCode } from '@webpieces/code-rules';

export default async function runExecutor(
    // webpieces-disable no-any-unknown -- schema options accepted but validateCode loads its own config
    _options: Record<string, unknown>,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return validateCode(context.root);
}
