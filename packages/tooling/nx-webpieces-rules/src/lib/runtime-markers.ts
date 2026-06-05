/**
 * Runtime Markers
 *
 * Reads the per-service `live.json` marker files and builds a workspace model
 * used to assemble the runtime microservice graph and to validate each service
 * independently.
 *
 * `live.json` (at a project root) declares, at api-PROJECT granularity (by
 * package name), which api projects a service IMPLEMENTS (serves) and which it
 * USES (calls as a client):
 *
 *   { "implements": ["@scope/checkout-api"], "uses": ["@scope/payments-api"] }
 *
 * An "api project" is any project whose workspace-relative root matches one of
 * the `apiProjectPaths` globs from webpieces.config.json (e.g. "libraries/apis/*").
 */

import * as fs from 'fs';
import * as path from 'path';
import { createProjectGraphAsync, readProjectsConfigurationFromProjectGraph } from '@nx/devkit';
import { isPathExcluded } from '@webpieces/rules-config';
import { toError } from '../toError';

export const LIVE_MARKER_FILENAME = 'live.json';

/** Parsed `live.json` contents (package names). */
export interface LiveMarker {
    implements: string[];
    uses: string[];
}

/** Everything we know about one workspace project for runtime analysis. */
export interface ProjectInfo {
    name: string;
    root: string;
    packageName: string | null;
    isApi: boolean;
    /** Workspace project names this project depends on (from the Nx graph). */
    deps: string[];
}

/** The whole-workspace model used by the generator and validators. */
export interface WorkspaceModel {
    projects: Map<string, ProjectInfo>;
    byPackageName: Map<string, string>;
}

/** Result of mapping package names to workspace projects. */
export interface ResolvedNames {
    projects: string[];
    unknown: string[];
}

/** Minimal shapes for the JSON files we parse. */
interface PackageJsonShape {
    name?: string;
}
interface LiveMarkerShape {
    implements?: string[];
    uses?: string[];
}
/** One Nx project-graph dependency edge (the slice we use). */
interface GraphEdge {
    target: string;
}

/**
 * A project root is an "api project" when it matches one of the apiProjectPaths
 * globs. Reuses the shared glob matcher (segment / glob / dir-prefix semantics).
 */
function isApiRoot(root: string, apiProjectPaths: string[]): boolean {
    if (apiProjectPaths.length === 0) return false;
    return isPathExcluded(root, apiProjectPaths);
}

function readPackageName(workspaceRoot: string, projectRoot: string): string | null {
    const pkgPath = path.join(workspaceRoot, projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        const parsed = JSON.parse(raw) as PackageJsonShape;
        return typeof parsed.name === 'string' ? parsed.name : null;
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return null;
    }
}

function collectDeps(
    name: string,
    dependencies: Record<string, GraphEdge[]>,
    workspaceNames: Set<string>,
): string[] {
    const deps: string[] = [];
    for (const edge of dependencies[name] ?? []) {
        if (edge.target !== name && workspaceNames.has(edge.target)) {
            deps.push(edge.target);
        }
    }
    return Array.from(new Set(deps)).sort();
}

/**
 * Build the workspace model from the Nx project graph. Dependency edges come
 * from Nx (imports + package.json), the same source dependencies.json uses, so
 * this works whether or not a service has its own package.json.
 */
export async function buildWorkspaceModel(
    workspaceRoot: string,
    apiProjectPaths: string[],
): Promise<WorkspaceModel> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);

    const projects = new Map<string, ProjectInfo>();
    const byPackageName = new Map<string, string>();
    const workspaceNames = new Set(Object.keys(projectGraph.nodes));

    for (const [name, cfg] of Object.entries(projectsConfig.projects)) {
        const root = cfg.root;
        if (root === '' || root === '.') continue;

        const packageName = readPackageName(workspaceRoot, root);
        projects.set(name, {
            name,
            root,
            packageName,
            isApi: isApiRoot(root, apiProjectPaths),
            deps: collectDeps(name, projectGraph.dependencies, workspaceNames),
        });
        if (packageName) byPackageName.set(packageName, name);
    }

    return { projects, byPackageName };
}

/** Read and normalize a project's `live.json`, or null if it has none. */
export function readLiveMarker(workspaceRoot: string, projectRoot: string): LiveMarker | null {
    const fullPath = path.join(workspaceRoot, projectRoot, LIVE_MARKER_FILENAME);
    if (!fs.existsSync(fullPath)) return null;

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw) as LiveMarkerShape;
        return {
            implements: Array.isArray(parsed.implements) ? parsed.implements : [],
            uses: Array.isArray(parsed.uses) ? parsed.uses : [],
        };
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`Failed to parse ${projectRoot}/${LIVE_MARKER_FILENAME}: ${error.message}`);
    }
}

/**
 * Map a list of api package names (from live.json) to workspace project names.
 * Unknown names (not a workspace package) are returned in `unknown`.
 */
export function resolvePackageNames(
    model: WorkspaceModel,
    packageNames: string[],
): ResolvedNames {
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const pkg of packageNames) {
        const project = model.byPackageName.get(pkg);
        if (project) resolved.push(project);
        else unknown.push(pkg);
    }
    return { projects: resolved, unknown };
}
