import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { PrismaValidateDtosValidator } from '@webpieces/code-rules';
import { PrismaValidateDtosConfig } from "@webpieces/code-rules";

export default async function runExecutor(
    options: PrismaValidateDtosConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new PrismaValidateDtosValidator(options).run(context.root);
}
