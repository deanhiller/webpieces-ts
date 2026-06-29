import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoDirectApiResolverValidator } from '@webpieces/code-rules';
import { AngularNoDirectApiInResolverConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: AngularNoDirectApiInResolverConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoDirectApiResolverValidator(options).run(context.root);
}
