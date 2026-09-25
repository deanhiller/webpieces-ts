import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoImplicitAnyValidator, GateScanScope } from '@webpieces/code-rules';
import { NoImplicitAnyConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: NoImplicitAnyConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoImplicitAnyValidator(options, new GateScanScope()).run(context.root);
}
