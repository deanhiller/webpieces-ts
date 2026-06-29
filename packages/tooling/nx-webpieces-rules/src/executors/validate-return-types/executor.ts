import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { RequireReturnTypeValidator } from '@webpieces/code-rules';
import { RequireReturnTypeConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: RequireReturnTypeConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new RequireReturnTypeValidator(options).run(context.root);
}
