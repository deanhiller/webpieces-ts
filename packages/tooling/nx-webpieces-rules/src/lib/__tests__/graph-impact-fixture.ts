/**
 * Synthetic nx project graphs for the Impact specs (#1264), classified with nx's OWN affected
 * locators imported straight from nx — the same functions `filterAffected` runs.
 */
import type { ProjectGraph, ProjectGraphProjectNode, TargetConfiguration } from '@nx/devkit';
import type { FileChange } from 'nx/src/project-graph/file-utils';
import type { PackageJson } from 'nx/src/utils/package-json';
import { WholeFileChange } from 'nx/src/project-graph/file-utils';
import type { TouchedProjectLocator } from 'nx/src/project-graph/affected/affected-project-graph-models';
import { getImplicitlyTouchedProjects, getTouchedProjects } from 'nx/src/project-graph/affected/locators/workspace-projects';
import { getTouchedProjectsFromLockFile } from 'nx/src/plugins/js/project-graph/affected/lock-file-changes';
import { getTouchedNpmPackages } from 'nx/src/plugins/js/project-graph/affected/npm-packages';
import { getTouchedProjectsFromTsConfig } from 'nx/src/plugins/js/project-graph/affected/tsconfig-json-changes';
import { NxAffectedLocators } from '../graph-impact-reasons';

/** nx's `getTouchedProjectsFromProjectGlobChanges` starts plugin workers; a deleted config is not under test. */
const NO_DELETED_CONFIG: TouchedProjectLocator = (): string[] => [];

export class ImpactGraphFixture {
    static readonly PACKAGE_JSON: PackageJson = { name: 'workspace', version: '0.0.0' };

    static locators(): NxAffectedLocators {
        return new NxAffectedLocators(
            getTouchedProjects,
            getImplicitlyTouchedProjects,
            NO_DELETED_CONFIG,
            getTouchedProjectsFromLockFile as TouchedProjectLocator,
            getTouchedNpmPackages,
            getTouchedProjectsFromTsConfig,
        );
    }

    /** A changed file whose content diff nx does not look into. */
    static wholeFile(file: string): FileChange {
        return { file, getChanges: () => [new WholeFileChange()] };
    }

    static project(name: string, root: string, targets: Record<string, TargetConfiguration> = {}): ProjectGraphProjectNode {
        return { name, type: 'lib', data: { root, targets } };
    }

    /** A graph from nodes, `[source, target]` edges, and `npm:` package names. */
    static graph(nodes: ProjectGraphProjectNode[], edges: string[][], external: string[] = []): ProjectGraph {
        const graph: ProjectGraph = { nodes: {}, dependencies: {}, externalNodes: {} };
        for (const node of nodes) {
            graph.nodes[node.name] = node;
            graph.dependencies[node.name] = [];
        }
        for (const name of external)
            (graph.externalNodes ?? {})[name] = { name: name as `npm:${string}`, type: 'npm', data: { version: '1.0.0', packageName: name.slice(4) } };
        for (const edge of edges) graph.dependencies[edge[0]].push({ source: edge[0], target: edge[1], type: 'static' });
        return graph;
    }
}
