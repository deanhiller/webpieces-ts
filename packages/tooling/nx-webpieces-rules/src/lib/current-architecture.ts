/**
 * The architecture graph as the CURRENT source says it is, built live by the same pipeline
 * `architecture:generate` runs — never read back from the committed architecture/*.json. Shared by
 * `validate-architecture-unchanged` (which diffs it against the committed file) and the Impact view's
 * edge changes (#1264, which diff it against the fork point's committed file).
 */

import { Option, RuleFailError } from '@webpieces/rules-config';
import { generateReducedGraph } from './graph-generator';
import { sortGraphTopologically } from './graph-sorter';
import type { EnhancedGraph } from './graph-sorter';
import { loadBlessedGraph } from './graph-loader';
import { collectProjectInfo, enrichGraph } from './graph-metadata';
import { TagTruthCheck } from './tag-truth';
import { ApprovedWiringGraph } from './runtime-wiring/approved-graph';
import type { ExternalSystemDecls } from './api-usage/api-relations';
import type { ApiContractFileRefs } from './api-contract-files';
import type { RemoteServices } from './remote-services';

/**
 * Build the current dependency graph exactly as the generator does: reduce the nx
 * graph, sort into levels, enrich with metadata, and attach the derived
 * apiRelations — so this validator compares like-for-like against the committed file.
 */
export class CurrentGraphBuilder {
    async build(workspaceRoot: string, graphPath?: string): Promise<CurrentArchitecture> {
        console.log('📊 Generating current dependency graph...');
        const reducedGraph = await generateReducedGraph();
        console.log('🔄 Computing topological layers...');
        const currentGraph = sortGraphTopologically(reducedGraph);
        console.log('🏷️  Enriching graph with framework + responsibilities metadata...');
        const projectInfos = await collectProjectInfo();
        enrichGraph(currentGraph, projectInfos, workspaceRoot);
        new TagTruthCheck().assertTrue(currentGraph, projectInfos, workspaceRoot);
        new ApprovedWiringGraph().attach(workspaceRoot, currentGraph, projectInfos, graphPath);
        const saved = loadBlessedGraph(workspaceRoot, graphPath);
        if (saved === null)
            throw new RuleFailError(
                'validate-runtime-architecture',
                'Missing approved graph.',
                undefined,
                undefined,
                [
                    new Option(
                        'Migrate src/wiring.ts and review runtime-deps.json and API contract approvals.',
                        true,
                    ),
                ],
            );
        return new CurrentArchitecture(
            currentGraph,
            saved.apiContractFiles,
            saved.externalSystems,
            saved.remoteServices,
        );
    }
}

/** The regenerated graph plus the tables beside it — everything dependencies.json holds. */
export class CurrentArchitecture {
    constructor(
        public readonly graph: EnhancedGraph,
        public readonly apiContractFiles: ApiContractFileRefs,
        public readonly externalSystems: ExternalSystemDecls,
        public readonly remoteServices: RemoteServices,
    ) {}
}
