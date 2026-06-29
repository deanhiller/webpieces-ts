import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { PrismaValidateDtosValidator } from '@webpieces/code-rules';
import { PrismaValidateDtosConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: PrismaValidateDtosConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new PrismaValidateDtosValidator(options).run(context.root);
}
