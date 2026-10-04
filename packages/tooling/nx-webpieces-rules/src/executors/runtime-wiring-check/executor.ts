import type { ExecutorContext } from '@nx/devkit';
import { renderRuleFailForHuman, Option, RuleFailError } from '@webpieces/rules-config';
import { collectProjectInfo } from '../../lib/graph-metadata';
import { RuntimeWiringVerification } from '../../lib/runtime-wiring/verification';
import { toError } from '../../toError';

export class RuntimeWiringCheckOptions {
    constructor(public readonly outputPath: string) {}
}

export class RuntimeWiringCheckResult {
    constructor(public readonly success: boolean) {}
}

// webpieces-disable no-function-outside-class -- Nx executor process entry point
export default async function executor(
    options: RuntimeWiringCheckOptions,
    context: ExecutorContext,
): Promise<RuntimeWiringCheckResult> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const infos = await collectProjectInfo();
        const info = context.projectName === undefined ? undefined : infos.get(context.projectName);
        if (info === undefined)
            throw new RuleFailError(
                'validate-runtime-architecture',
                'runtime-wiring-check requires a named project.',
                undefined,
                undefined,
                [
                    new Option(
                        'Run nx run <project>:runtime-wiring-check on a tagged project.',
                        true,
                    ),
                ],
            );
        new RuntimeWiringVerification().verify(context.root, info, infos, options.outputPath);
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error(
            error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message,
        );
        return { success: false };
    }
}
