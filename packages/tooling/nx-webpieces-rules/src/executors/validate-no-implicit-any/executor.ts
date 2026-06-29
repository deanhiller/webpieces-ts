import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoImplicitAnyValidator } from '@webpieces/code-rules';
import { NoImplicitAnyConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: NoImplicitAnyConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoImplicitAnyValidator(options).run(context.root);
}
