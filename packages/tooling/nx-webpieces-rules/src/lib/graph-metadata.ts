/**
 * Graph Metadata Enrichment
 *
 * Fills the AI-oriented fields on each architecture/dependencies.json entry:
 *   framework            — from `framework:<x>` nx tag or package.json inference
 *   shortDescription     — first paragraph of the project's responsibilities.md
 *   responsibilitiesFile — repo-relative path to the required responsibilities.md
 *   designFile           — repo-relative path to the generated DI design.json
 *
 * Validation is aggregated: ALL problems across ALL projects are collected and
 * thrown as one MetadataValidationError so a repo adopting this sees the full
 * seeding list in a single run. Callers must enrich BEFORE writing any file so
 * a failed run never clobbers dependencies.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createProjectGraphAsync } from '@nx/devkit';
import type { EnhancedGraph } from './graph-sorter';
import { ProjectInfo } from './project-info';
import { resolveFramework } from './framework-resolver';
import { extractShortDescription, validateShortDescription } from './responsibilities';

export const RESPONSIBILITIES_FILE_NAME = 'responsibilities.md';

/**
 * Thrown when one or more projects fail metadata validation (missing/invalid
 * responsibilities.md, bad framework tags, ...). Executors catch this to point
 * AI at the webpieces.responsibilities.md instructions template.
 */
export class MetadataValidationError extends Error {
    constructor(public readonly problems: string[]) {
        super(
            `Architecture metadata validation failed (${problems.length} problem(s)):\n` +
                problems.map((problem: string) => `  - ${problem}`).join('\n')
        );
        this.name = 'MetadataValidationError';
    }
}

/**
 * Read per-project root + tags from nx's project graph.
 */
export async function collectProjectInfo(): Promise<Map<string, ProjectInfo>> {
    const projectGraph = await createProjectGraphAsync();
    const infos = new Map<string, ProjectInfo>();
    for (const [name, node] of Object.entries(projectGraph.nodes)) {
        infos.set(name, new ProjectInfo(name, node.data.root, node.data.tags ?? []));
    }
    return infos;
}

/**
 * Enrich every graph entry in place with framework, shortDescription,
 * responsibilitiesFile and designFile. Throws MetadataValidationError listing
 * every problem when any project fails validation.
 */
export function enrichGraph(
    graph: EnhancedGraph,
    infos: Map<string, ProjectInfo>,
    workspaceRoot: string
): void {
    const problems: string[] = [];

    for (const [projectName, entry] of Object.entries(graph)) {
        const info = infos.get(projectName);
        if (!info) {
            problems.push(`${projectName}: not found in nx project graph`);
            continue;
        }

        const resolution = resolveFramework(info, workspaceRoot);
        if (resolution.problem !== null) {
            problems.push(resolution.problem);
        } else if (resolution.framework !== null) {
            entry.framework = resolution.framework;
        }

        enrichResponsibilities(entry, info, workspaceRoot, problems);

        // Only project.json projects get a generated design.json (see di-graph-targets.ts)
        if (fs.existsSync(path.join(workspaceRoot, info.root, 'project.json'))) {
            entry.designFile = toRepoRelative(info.root, 'design.json');
        }
    }

    if (problems.length > 0) {
        throw new MetadataValidationError(problems);
    }
}

function enrichResponsibilities(
    entry: EnhancedGraph[string],
    info: ProjectInfo,
    workspaceRoot: string,
    problems: string[]
): void {
    const responsibilitiesFile = toRepoRelative(info.root, RESPONSIBILITIES_FILE_NAME);
    entry.responsibilitiesFile = responsibilitiesFile;

    const absolutePath = path.join(workspaceRoot, info.root, RESPONSIBILITIES_FILE_NAME);
    if (!fs.existsSync(absolutePath)) {
        problems.push(
            `${info.name}: missing required ${responsibilitiesFile} — create it with a heading, ` +
                `one short summary paragraph, then the full responsibilities of the module`
        );
        return;
    }

    const summary = extractShortDescription(fs.readFileSync(absolutePath, 'utf-8'));
    const summaryProblem = validateShortDescription(summary, responsibilitiesFile);
    if (summaryProblem !== null) {
        problems.push(`${info.name}: ${summaryProblem}`);
        return;
    }
    entry.shortDescription = summary;
}

/**
 * Repo-relative path with forward slashes (stable across platforms in the
 * committed JSON).
 */
function toRepoRelative(projectRoot: string, fileName: string): string {
    return [projectRoot.replace(/\\/g, '/').replace(/\/+$/, ''), fileName].join('/');
}
