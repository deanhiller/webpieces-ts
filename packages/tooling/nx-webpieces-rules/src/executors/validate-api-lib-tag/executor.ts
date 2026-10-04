/**
 * Validate API-lib Tag Executor
 *
 * Fails when the api roles and the code disagree, in either direction: a project
 * tagged role:api-lib that exports neither a contract (@ApiPath/@Rpc/@PubSub,
 * @WpInternal/@WpIpcEndpoint, or an in-process abstract …Api) nor only wire types,
 * a role:api-client that exports no contract, or a project that exports an
 * @ApiPath/@Rpc/@PubSub abstract class but carries neither api role (#1064, D3).
 *
 * Usage:
 * nx run architecture:validate-api-lib-tag
 */

import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import type { ExecutorContext } from '@nx/devkit';
import { collectProjectInfo } from '../../lib/graph-metadata';
import { ApiContractEvidence } from '../../lib/api-usage/api-contract-evidence';
import { loadRuntimeConfig } from '../../lib/runtime-config';
import {
    findApiLibTagViolations,
    describeApiLibTagViolation,
} from '../../lib/api-usage/api-lib-tag-validator';
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
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    console.log('\n🏷️  Validating role:api-lib tag ⇔ API contract exports\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const projectInfos = await collectProjectInfo();
        const scan = new ApiContractEvidence().collect(
            workspaceRoot,
            projectInfos,
            loadRuntimeConfig(workspaceRoot).externalApiPaths,
        );
        const violations = findApiLibTagViolations(projectInfos, scan, workspaceRoot);

        if (violations.length === 0) {
            console.log(
                '✅ role:api-lib / role:api-client match the code (every api library exports a contract or only wire types, and vice-versa).',
            );
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
        console.error(
            '❌ api-lib tag validation failed:',
            error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message,
        );
        return { success: false };
    }
}
