import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoDestructureValidator } from '@webpieces/code-rules';
import { NoDestructureConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: NoDestructureConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoDestructureValidator(options).run(context.root);
}
