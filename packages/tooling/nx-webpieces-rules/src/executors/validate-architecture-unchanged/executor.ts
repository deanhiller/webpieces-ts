/**
 * Validate Architecture Unchanged Executor
 *
 * Validates that the current architecture graph matches the saved blessed graph.
 * This ensures no unapproved architecture changes have been made.
 *
 * Usage:
 * nx run architecture:validate-architecture-unchanged
 */

import type { ExecutorContext } from '@nx/devkit';
import {
    writeTemplate,
    Option,
    RuleFailError,
    renderRuleFailForHuman,
} from '@webpieces/rules-config';
import { generateReducedGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { compareGraphs } from '../../lib/graph-comparator';
import { loadBlessedGraph, graphFileExists } from '../../lib/graph-loader';
import type { DependenciesFile } from '../../lib/graph-loader';
import { collectProjectInfo, enrichGraph, MetadataValidationError } from '../../lib/graph-metadata';
import { TagTruthCheck } from '../../lib/tag-truth';
import { WorkspaceClientBindings } from '../../lib/runtime-wiring/canonical-clients';
import { ApprovedWiringGraph } from '../../lib/runtime-wiring/approved-graph';
import type { ExternalSystemDecls } from '../../lib/api-usage/api-relations';
import { ApiContractFiles } from '../../lib/api-contract-files';
import type { ApiContractFileRefs } from '../../lib/api-contract-files';
import { RuleGate } from '../../lib/rule-gate';
import type { EnhancedGraph } from '../../lib/graph-sorter';
import { toError } from '../../toError';

export interface ValidateArchitectureUnchangedOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

const TMP_MD_FILE = 'webpieces.dependencies.md';

/**
 * Write the instructions documentation to .webpieces/instruct-ai/.
 * Sourced from @webpieces/rules-config.
 */
function writeTmpInstructionsFile(workspaceRoot: string): string {
    const mdPath = writeTemplate(workspaceRoot, TMP_MD_FILE);

    return mdPath;
}

/**
 * Report a current-vs-saved graph mismatch and write the AI instructions file.
 */
function reportMismatch(summary: string, workspaceRoot: string): void {
    const mdPath = writeTmpInstructionsFile(workspaceRoot);

    console.error('❌ Architecture has changed since last update!');
    console.error('\nDifferences:');
    console.error(summary);
    console.error('');
    console.error('⚠️  *** Refer to ' + mdPath + ' for instructions on how to fix *** ⚠️');
    console.error('');
    console.error('To fix:');
    console.error('  1. Review the changes above');
    console.error(
        '  2. If intentional, ASK USER to run: nx run architecture:generate since this is a critical change',
    );
    console.error('  3. Commit the updated architecture/dependencies.json');
}

/**
 * Which APIs dependencies.json links to a contract file, compared by LINK only — an added or removed
 * API. The endpoints inside `architecture/apis/<Api>.json` are deliberately NOT compared (#949): an
 * endpoint change must not fail this rule. Null when the links match.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches reportMismatch in this file
function describeContractLinkDrift(
    current: ApiContractFileRefs,
    saved: ApiContractFileRefs,
): string | null {
    const names = [...new Set([...Object.keys(current), ...Object.keys(saved)])].sort();
    const changes: string[] = [];
    for (const name of names) {
        const a = current[name];
        const b = saved[name];
        if (a === undefined)
            changes.push(`  - ${name}: linked in dependencies.json but no longer in source`);
        else if (b === undefined)
            changes.push(`  + ${name}: in source but not linked from dependencies.json`);
        else if (a !== b) changes.push(`  ~ ${name}: contract file link changed (${b} -> ${a})`);
    }
    if (changes.length === 0) return null;
    return `apiContractFiles drift (${changes.length} api(s)):\n${changes.join('\n')}`;
}

/**
 * Drift in EITHER side table of dependencies.json — the api contract-file links or the
 * external-system declarations — or null when both match. The first difference found is reported;
 * fixing it is the same single command either way, so listing both adds noise rather than information.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches describeContractLinkDrift above
export function describeTableDrift(
    current: CurrentArchitecture,
    saved: DependenciesFile,
): string | null {
    const linkDrift = describeContractLinkDrift(current.apiContractFiles, saved.apiContractFiles);
    if (linkDrift !== null) return linkDrift;
    return describeExternalSystemDrift(current.externalSystems, saved.externalSystems);
}

/**
 * The same drift report for the declared external systems, or null when they match. Named per
 * system so the message points at the database that changed rather than dumping two JSON blobs.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches describeContractLinkDrift above
function describeExternalSystemDrift(
    current: ExternalSystemDecls,
    saved: ExternalSystemDecls,
): string | null {
    const names = [...new Set([...Object.keys(current), ...Object.keys(saved)])].sort();
    const changes: string[] = [];
    for (const name of names) {
        const a = current[name];
        const b = saved[name];
        if (a === undefined)
            changes.push(`  - ${name}: in dependencies.json but no longer declared in source`);
        else if (b === undefined)
            changes.push(`  + ${name}: declared in source but missing from dependencies.json`);
        else if (JSON.stringify(a) !== JSON.stringify(b))
            changes.push(`  ~ ${name}: kind/label/declarers changed`);
    }
    if (changes.length === 0) return null;
    return `externalSystems drift (${changes.length} system(s)):\n${changes.join('\n')}`;
}

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
        new WorkspaceClientBindings().assert(workspaceRoot, projectInfos);
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
        return new CurrentArchitecture(currentGraph, saved.apiContractFiles, saved.externalSystems);
    }
}

/** The regenerated graph plus the two tables beside it — everything dependencies.json holds. */
export class CurrentArchitecture {
    constructor(
        public readonly graph: EnhancedGraph,
        public readonly apiContractFiles: ApiContractFileRefs,
        public readonly externalSystems: ExternalSystemDecls,
    ) {}
}

/** The bootstrap path: there is nothing to diff against yet, so say how to create it. */
// webpieces-disable no-function-outside-class -- executor step helper, matches reportMismatch in this file
function reportMissingGraph(): never {
    throw new RuleFailError(
        'validate-runtime-architecture',
        'Missing reviewed architecture/dependencies.json.',
        undefined,
        undefined,
        [
            new Option(
                'Run owning API source build checks to emit contract candidates, review and copy them into architecture/apis/<ApiName>.json, and create dependencies.json with projects:{}, apiContractFiles:{"<ApiName>":"apis/<ApiName>.json"}, and reviewed externalSystems. Approve tagged owners runtime-deps.json candidates, then run architecture:generate and review the resulting graph.',
                true,
            ),
        ],
    );
}

export default async function runExecutor(
    options: ValidateArchitectureUnchangedOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const graphPath = options.graphPath;
    const workspaceRoot = context.root;

    // Epoch-gateable: this rule diffs against the blessed architecture/dependencies.json, so
    // "grandfather the current drift until <epoch>" is meaningful — hence honorEpoch = true.
    if (new RuleGate().isDisabled(workspaceRoot, 'validate-architecture-unchanged', true)) {
        return { success: true };
    }

    console.log('\n🔍 Validating Architecture Unchanged\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Check if saved graph exists
        if (!graphFileExists(workspaceRoot, graphPath)) {
            reportMissingGraph();
            return { success: false };
        }

        // Steps 1-3: build + enrich + scan the current graph (same pipeline the
        // generator runs, so any drift is caught).
        const currentGraph = await new CurrentGraphBuilder().build(workspaceRoot, graphPath);

        // Step 4: Load saved graph
        console.log('📂 Loading saved graph...');
        const savedGraph = loadBlessedGraph(workspaceRoot, graphPath);

        if (!savedGraph) {
            console.error('❌ Could not load saved graph');
            return { success: false };
        }

        // Step 5: Compare graphs
        console.log('🔍 Comparing current graph to saved graph...');
        const comparison = compareGraphs(currentGraph.graph, savedGraph.projects);

        if (!comparison.identical) {
            reportMismatch(comparison.summary, workspaceRoot);
            return { success: false };
        }

        // Step 6: Compare the two side tables as well: which APIs are linked to a contract file, and
        // the external-system declarations. The endpoints inside architecture/apis/<Api>.json are
        // NOT compared — an endpoint change must never fail this rule (#949).
        const tableDrift = describeTableDrift(currentGraph, savedGraph);
        if (tableDrift !== null) {
            reportMismatch(tableDrift, workspaceRoot);
            return { success: false };
        }

        console.log('✅ Architecture unchanged - current graph matches saved graph');
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        // A RuleFailError (e.g. a dependencies.json still carrying the moved `apiContracts` key)
        // carries its cures in Option[]; render them rather than dropping them with `.message`.
        const rendered =
            error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message;
        console.error('❌ Architecture validation failed:', rendered);
        reportMetadataFailure(error, workspaceRoot);
        return { success: false };
    }
}

// webpieces-disable no-function-outside-class -- executor diagnostic formatting
function reportMetadataFailure(error: Error, workspaceRoot: string): void {
    if (error instanceof MetadataValidationError) {
        const mdPath = writeTemplate(workspaceRoot, 'webpieces.responsibilities.md');
        console.error('');
        console.error(
            '⚠️  *** Refer to ' + mdPath + ' for how to author responsibilities.md files *** ⚠️',
        );
    }
}
