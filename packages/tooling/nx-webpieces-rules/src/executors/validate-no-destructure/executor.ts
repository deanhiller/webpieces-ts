import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { NoDestructureValidator, GateScanScope } from '@webpieces/code-rules';
import { NoDestructureConfig } from "@webpieces/code-rules";

export default async function runExecutor(
    options: NoDestructureConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new NoDestructureValidator(options, new GateScanScope()).run(context.root);
}
