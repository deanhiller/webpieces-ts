import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoAnyUnknownValidator } from '@webpieces/code-rules';
import { NoAnyUnknownConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: NoAnyUnknownConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoAnyUnknownValidator(options).run(context.root);
}
