import { ApiContractApproval } from './api-contract-approval';
import { buildExternalSystems } from './external-systems';
import * as fs from 'fs';
import * as path from 'path';
import { ApiSourceIndexBuilder, buildApiContracts } from './api-scanner';
import { DecoratorArgDiagnostics } from './api-ast';
import { RootUnionRule, RootUnionScan } from './root-union-scan';
import { ApiDocRule, MCP_RULE, OPENAPI_RULE } from './api-doc-rules';
import { ApiDocRulesScan } from './api-doc-rules-scan';
import { WireClosureRule } from './wire-closure';
import type { ApiScanResult } from './api-scanner';
import type { ProjectInfo } from '../project-info';

/** Build evidence for API/DTO correctness. No runtime relationship scan or project compiler loop. */
export class ApiContractEvidence {
    collect(
        workspaceRoot: string,
        infos: Map<string, ProjectInfo>,
        externalApiPaths: readonly string[],
    ): ApiScanResult {
        const diagnostics = new DecoratorArgDiagnostics(workspaceRoot);
        const index = new ApiSourceIndexBuilder(
            workspaceRoot,
            infos,
            externalApiPaths,
            diagnostics,
        ).build();
        const result: ApiScanResult = {
            relationsByProject: new Map(),
            apiLibProjects: index.owners,
            apiIndex: index.byName,
            scannedProjects: new Set(
                [...infos.values()]
                    .filter((info) => fs.existsSync(path.join(workspaceRoot, info.root, 'src')))
                    .map((info) => info.name),
            ),
            unresolvedApiCalls: [],
            nonLiteralDecoratorArgs: diagnostics.all(),
            unresolvedEndpointPaths: diagnostics.unresolvedEndpointPaths(),
            emptiedApiContracts: diagnostics.emptiedContracts(),
            undeclaredExternalCallers: diagnostics.undeclaredExternalCallers(),
            undeclaredEndpointOperations: diagnostics.undeclaredEndpointOperations(),
            rootUnions: new RootUnionScan(
                workspaceRoot,
                infos,
                RootUnionRule.fromConfig(workspaceRoot),
            ).run(),
            apiDocRules: new ApiDocRulesScan(
                workspaceRoot,
                infos,
                ApiDocRule.fromConfig(workspaceRoot, OPENAPI_RULE),
                ApiDocRule.fromConfig(workspaceRoot, MCP_RULE),
                WireClosureRule.fromConfig(workspaceRoot),
            ).run(),
        };
        new ApiContractApproval().verify(
            workspaceRoot,
            infos,
            buildApiContracts(result),
            buildExternalSystems(index.byName, infos),
        ); // Preserves the previous generator's API/DTO correctness failures.
        return result;
    }
}
