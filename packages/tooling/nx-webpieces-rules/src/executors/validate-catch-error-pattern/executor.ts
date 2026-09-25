import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { CatchErrorPatternValidator, GateScanScope } from '@webpieces/code-rules';
import { CatchErrorPatternConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: CatchErrorPatternConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new CatchErrorPatternValidator(options, new GateScanScope()).run(context.root);
}
