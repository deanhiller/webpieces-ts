import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { PrismaConverterValidator } from '@webpieces/code-rules';
import { PrismaConverterConfig } from '@webpieces/rules-config';

export default async function runExecutor(
    options: PrismaConverterConfig,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return new PrismaConverterValidator(options).run(context.root);
}
