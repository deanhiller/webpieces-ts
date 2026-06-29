import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoInlineTypeLiteralsValidator } from '@webpieces/code-rules';
import { NoInlineTypeLiteralsConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: NoInlineTypeLiteralsConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoInlineTypeLiteralsValidator(options).run(context.root);
}
