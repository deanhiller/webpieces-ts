/**
 * Validate API Relations Executor
 *
 * Fails when a runnable project (role:server / role:client) depends on an api-lib
 * but the source scan finds it neither IMPLEMENTS (serves via addRoutes) nor USES
 * (calls via createRpcClient/createPubSubClient) any of that api-lib's contracts.
 * Such an edge is an unexplained dependency — a dead import or forgotten wiring.
 *
 * Usage:
 * nx run architecture:validate-api-relations
 */

import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { collectProjectInfo, enrichGraph } from '../../lib/graph-metadata';
import { ApprovedWiringGraph } from '../../lib/runtime-wiring/approved-graph';
import { loadBlessedGraph } from '../../lib/graph-loader';
import { ApiContractFiles } from '../../lib/api-contract-files';
import {
    ApiRelationEvidence,
    ApiOwnerIdentity,
    findUnclassifiedApiDeps,
    describeUnclassifiedApiDep,
} from '../../lib/api-usage/api-relations-validator';
import { toError } from '../../toError';

export interface ValidateApiRelationsOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

// webpieces-disable no-function-outside-class -- nx executor entry point (default export), like every sibling executor
export default async function runExecutor(
    _options: ValidateApiRelationsOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;

    console.log('\n🔗 Validating API Relations (implements/uses per api-lib dependency)\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Full (un-reduced) graph so a direct api-lib dependency is never hidden by
        // transitive reduction, then attach the derived apiRelations.
        const rawGraph = await generateGraph();
        const graph = sortGraphTopologically(rawGraph);
        const projectInfos = await collectProjectInfo();
        enrichGraph(graph, projectInfos, workspaceRoot);
        new ApprovedWiringGraph().attach(workspaceRoot, graph, projectInfos);
        const saved = loadBlessedGraph(workspaceRoot);
        if (saved === null) return { success: false };
        const contracts = new ApiContractFiles().load(
            workspaceRoot,
            'architecture/dependencies.json',
            saved.apiContractFiles,
        );
        const scan = new ApiRelationEvidence(
            new Set(Object.keys(graph).filter((name) => graph[name].runtimeComposition)),
            new Set(Object.values(contracts).map((contract) => contract.owner)),
            [],
            new Map(
                Object.entries(contracts).map(
                    (entry) => [entry[0], new ApiOwnerIdentity(entry[0], entry[1].owner)] as const,
                ),
            ),
        );
        const violations = findUnclassifiedApiDeps(graph, projectInfos, scan);
        if (violations.length === 0) {
            console.log('✅ Every server/client api-lib dependency is implemented or used.');
            return { success: true };
        }

        console.error(`❌ ${violations.length} unexplained api-lib dependenc(ies):\n`);
        for (const violation of violations) {
            console.error(describeUnclassifiedApiDep(violation));
            console.error('');
        }
        return { success: false };
    } catch (err: unknown) {
        const error = toError(err);
        console.error(
            '❌ API relations validation failed:',
            error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message,
        );
        return { success: false };
    }
}
