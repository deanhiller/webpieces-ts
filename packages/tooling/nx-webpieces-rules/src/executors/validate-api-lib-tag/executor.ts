/**
 * Validate API-lib Tag Executor
 *
 * Fails when the `role:api-lib` tag and the code disagree, in either direction:
 * a project tagged role:api-lib that exports no API contract, or a project that
 * exports an @ApiPath/@Rpc/@PubSub abstract class but is not tagged role:api-lib.
 *
 * Usage:
 * nx run architecture:validate-api-lib-tag
 */

import type { ExecutorContext } from '@nx/devkit';
import { collectProjectInfo } from '../../lib/graph-metadata';
import { ApiUsageScanner } from '../../lib/api-usage/api-scanner';
import { findApiLibTagViolations, describeApiLibTagViolation } from '../../lib/api-usage/api-lib-tag-validator';
import { toError } from '../../toError';

export interface ValidateApiLibTagOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

// webpieces-disable no-function-outside-class -- nx executor entry point (default export), like every sibling executor
export default async function runExecutor(
    _options: ValidateApiLibTagOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    console.log('\n🏷️  Validating role:api-lib tag ⇔ API contract exports\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const projectInfos = await collectProjectInfo();
        const scan = new ApiUsageScanner(workspaceRoot, projectInfos).scan();
        const violations = findApiLibTagViolations(projectInfos, scan);

        if (violations.length === 0) {
            console.log('✅ role:api-lib matches the code (every api-lib exports a contract, and vice-versa).');
            return { success: true };
        }

        console.error(`❌ ${violations.length} role:api-lib tag/code mismatch(es):\n`);
        for (const violation of violations) {
            console.error(describeApiLibTagViolation(violation));
            console.error('');
        }
        return { success: false };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ api-lib tag validation failed:', error.message);
        return { success: false };
    }
}
