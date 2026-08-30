/**
 * Graph Metadata Enrichment
 *
 * Fills the AI-oriented fields on each architecture/dependencies.json entry:
 *   framework            — from `framework:<x>` nx tag or package.json inference
 *   serviceName          — from project.json metadata.webpieces.serviceName; the
 *                          name clients address this app by at runtime
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
import type { EnhancedGraph, GraphEntry } from './graph-sorter';
import { ProjectInfo } from './project-info';
import { resolveFramework } from './framework-resolver';
import { resolveRole } from './role-resolver';
import { resolveDrawOnGraph } from './draw-on-graph-resolver';
import { resolveCutLegacyCycles } from './cut-legacy-cycle-resolver';
import { resolveRuntimeParticipant } from './runtime-participant-resolver';
import { resolveCallsService, resolveServiceName, validateUniqueServiceNames } from './service-name-resolver';
import { extractShortDescription, validateShortDescription } from './responsibilities';
import { toError } from '../toError';

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
    // project -> declared serviceName, collected so duplicates can be reported across the workspace.
    const serviceNames = new Map<string, string>();

    for (const [projectName, entry] of Object.entries(graph)) {
        const info = infos.get(projectName);
        if (!info) {
            problems.push(`${projectName}: not found in nx project graph`);
            continue;
        }

        enrichDeclarations(entry, info, workspaceRoot, problems);
        enrichClientNames(entry, info, workspaceRoot, projectName, serviceNames, problems);
        enrichResponsibilities(entry, info, workspaceRoot, problems);

        // Set designFile ONLY when the project has a REAL generated design (a
        // non-empty `designs[]`), i.e. it has a @DocumentDesign root. A project
        // without one has NO design.json at all (di-graph-generate stopped writing
        // empty ones and reaps stale ones), and legacy repos may still carry an
        // empty `{ designs: [] }` until their next build — both must read the same
        // way, and neither gets a "View Design" item on its node menu in the arch
        // viz (designLinks keys off designFile). See graph-visualizer.ts.
        if (hasGeneratedDesign(workspaceRoot, info.root)) {
            entry.designFile = toRepoRelative(info.root, 'design.json');
        }
    }

    validateUniqueServiceNames(serviceNames, problems);
    validateLibraryTypesMatch(graph, problems);
    validateRoleDependencies(graph, problems);

    if (problems.length > 0) {
        throw new MetadataValidationError(problems);
    }
}

/**
 * The fields a project DECLARES about itself — its framework env set and role (nx tags), the
 * webpieces runtime packages it depends on (package.json), and whether it opts out of the drawings
 * (nx tag). Grouped because they share a shape: resolve, record the problem, or write the field.
 *
 * Distinct from enrichResponsibilities/designFile, which read generated or hand-written FILES.
 */
// webpieces-disable no-function-outside-class -- enrichGraph step helper, matching enrichClientNames/enrichResponsibilities in this file
function enrichDeclarations(
    entry: GraphEntry,
    info: ProjectInfo,
    workspaceRoot: string,
    problems: string[]
): void {
    const resolution = resolveFramework(info, workspaceRoot);
    if (resolution.problem !== null) {
        problems.push(resolution.problem);
    } else if (resolution.frameworks !== null) {
        entry.framework = resolution.frameworks;
    }

    const roleResolution = resolveRole(info);
    if (roleResolution.problem !== null) {
        problems.push(roleResolution.problem);
    } else if (roleResolution.role !== null) {
        entry.role = roleResolution.role;
    }

    // Only persist when the project declares at least one — a repo full of
    // "webpiecesRuntime": [] lines would be noise, and absence already means "declares none".
    const participantResolution = resolveRuntimeParticipant(info, workspaceRoot);
    if (participantResolution.problem !== null) {
        problems.push(participantResolution.problem);
    } else if (participantResolution.markers !== null && participantResolution.markers.length > 0) {
        entry.webpiecesRuntime = participantResolution.markers;
    }

    // Only persist the field when hidden (false); drawn projects (the
    // default) stay clean in dependencies.json with no drawOnGraph line.
    const drawResolution = resolveDrawOnGraph(info);
    if (drawResolution.problem !== null) {
        problems.push(drawResolution.problem);
    } else if (drawResolution.drawOnGraph === false) {
        entry.drawOnGraph = false;
    }

    // Only persist when the project actually cuts an edge — absence is the normal state, and a repo
    // full of "cutLegacyCycle": [] lines would bury the ones that mean something.
    const cutResolution = resolveCutLegacyCycles(info);
    if (cutResolution.problem !== null) {
        problems.push(cutResolution.problem);
    } else if (cutResolution.targets !== null && cutResolution.targets.length > 0) {
        entry.cutLegacyCycle = cutResolution.targets;
    }
}

/**
 * Roles that are terminal APPS — nothing may depend on them. A server, a
 * non-HTTP `app`, or a client is a top-level runnable; being depended upon means
 * it is really a library and should be retagged `role:lib`/`role:designed-lib`.
 */
export const APP_ROLES: ReadonlyArray<string> = ['server', 'app', 'client'];

/**
 * Compatibility lattice — the "up-set" of each atomic env is the env itself
 * PLUS every ancestor it can legally consume code from (specialization edges
 * child → parent: react → browser, angular → browser, express → node). A
 * consumer promising env `c` can be satisfied by any dependency env in `up(c)`.
 */
export const ENV_UP_SETS: Readonly<Record<string, ReadonlyArray<string>>> = {
    react: ['react', 'browser'],
    angular: ['angular', 'browser'],
    browser: ['browser'],
    express: ['express', 'node'],
    node: ['node'],
};

/** The up-set of an env (env itself + ancestors); unknown envs map to just themselves. */
function upSet(env: string): ReadonlyArray<string> {
    return ENV_UP_SETS[env] ?? [env];
}

/**
 * `library-types-match-client` rule.
 *
 * A project's `framework` field is its libType — the SET of runtime
 * environments it is validated to run in (browser | react | angular | node |
 * express). For a dependency edge Consumer C → Library L, the edge is LEGAL iff
 * for EVERY env `c` in C's set, up(c) ∩ L's set ≠ ∅ — i.e. every environment
 * the consumer promises to run in can be satisfied by the dependency. This keeps
 * an express app from depending on a browser-only lib, and lets a `browser+node`
 * lib be consumed by both react and express projects. Every violation is
 * appended to `problems` so `arch:generate` fails with the full list.
 */
export function validateLibraryTypesMatch(graph: EnhancedGraph, problems: string[]): void {
    for (const [projectName, entry] of Object.entries(graph)) {
        const fromSet = entry.framework;
        if (fromSet === undefined) continue; // framework resolution already flagged this project

        for (const dep of entry.dependsOn) {
            const depEntry = graph[dep];
            const toSet = depEntry?.framework;
            if (toSet === undefined) continue;

            const unsatisfied = fromSet.filter(
                (env: string) => !upSet(env).some((up: string) => toSet.includes(up))
            );
            if (unsatisfied.length === 0) continue;

            problems.push(
                `library-types-match-client: '${projectName}' [${fromSet.join(', ')}] must not depend on ` +
                    `'${dep}' [${toSet.join(', ')}] — the consumer env(s) ${unsatisfied.join(', ')} cannot be ` +
                    `satisfied by the dependency (each consumer env must resolve to itself or an ancestor it ` +
                    `consumes from: react/angular→browser, express→node). Widen '${dep}' framework tags or ` +
                    `remove the dependency.`
            );
        }
    }
}

/**
 * `role-dependency` rule.
 *
 * A project's `role` is its function (server | designed-lib | lib | client).
 * Apps are terminal — libraries and clients consume them, never the reverse:
 *   - a `client` is fully terminal: NOTHING may depend on it.
 *   - a `server` may only be depended upon by another `server` — the one
 *     legitimate case is a server-side orchestrator/e2e harness that boots
 *     other servers. A `lib`/`designed-lib`/`client` depending on a `server`
 *     inverts the dependency direction and is a violation.
 *   - a `bundle` is the one role permitted to depend on ANY app: it aggregates
 *     several apps into one distributable (e.g. an nx plugin re-exposing multiple
 *     tooling apps), so a `bundle → app` edge is legitimate, not inverted.
 */
export function validateRoleDependencies(graph: EnhancedGraph, problems: string[]): void {
    for (const [projectName, entry] of Object.entries(graph)) {
        const fromRole = entry.role;
        for (const dep of entry.dependsOn) {
            const toRole = graph[dep]?.role;
            if (toRole === undefined) continue; // role resolution already flagged this project
            if (!APP_ROLES.includes(toRole)) continue;
            // A server may orchestrate/boot other servers (e.g. an e2e harness).
            if (toRole === 'server' && fromRole === 'server') continue;
            // A bundle aggregates apps — it may depend on any app role.
            if (fromRole === 'bundle') continue;

            const why =
                toRole === 'client'
                    ? `a 'client' app is terminal and may never be depended upon`
                    : `a 'server' may only be depended upon by another 'server' (an orchestrator/e2e harness)`;
            problems.push(
                `role-dependency: '${projectName}' (role:${fromRole ?? 'none'}) must not depend on ` +
                    `'${dep}' (role:${toRole}) — ${why}. Retag '${dep}' role:lib/role:designed-lib if it ` +
                    `is actually a library, or remove the dependency.`
            );
        }
    }
}

/**
 * Fill the two symmetric client-addressing fields — `serviceName` (the name clients address THIS app
 * by) and `callsService` (the name THIS app's clients call when no literal ClientConfig sits at the
 * call site). Both are declared in project.json, never derived (see service-name-resolver.ts).
 */
// webpieces-disable no-function-outside-class -- pure enrichment helper, mirrors enrichResponsibilities
function enrichClientNames(
    entry: EnhancedGraph[string],
    info: ProjectInfo,
    workspaceRoot: string,
    projectName: string,
    serviceNames: Map<string, string>,
    problems: string[]
): void {
    const serviceResolution = resolveServiceName(info, workspaceRoot);
    if (serviceResolution.problem !== null) {
        problems.push(serviceResolution.problem);
    } else if (serviceResolution.serviceName !== null) {
        entry.serviceName = serviceResolution.serviceName;
        serviceNames.set(projectName, serviceResolution.serviceName);
    }

    // Consumed by the runtime graph's target resolution (runtime-graph.ts), between the call-site
    // literal and the fan-out fallback.
    const callsResolution = resolveCallsService(info, workspaceRoot);
    if (callsResolution.problem !== null) {
        problems.push(callsResolution.problem);
    } else if (callsResolution.callsService !== null) {
        entry.callsService = callsResolution.callsService;
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

/**
 * True when the project has a REAL generated DI design — a committed design.json
 * whose `designs[]` is non-empty (i.e. it has ≥1 @DocumentDesign root).
 *
 * MISSING, empty-`designs[]`, and unparseable all read as "no design", and that
 * equivalence is load-bearing rather than incidental: di-graph-generate writes NO
 * file for a project without a design root (and reaps a stale one), so "absent"
 * is now the normal state for every plain lib and legacy service. Repos that have
 * not rebuilt since still carry `{ designs: [] }` files. Either way the box's node
 * menu must offer no "View Design" item. See design-file-emission.spec.ts.
 */
function hasGeneratedDesign(workspaceRoot: string, projectRoot: string): boolean {
    const designPath = path.join(workspaceRoot, projectRoot, 'design.json');
    if (!fs.existsSync(designPath)) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const parsed = JSON.parse(fs.readFileSync(designPath, 'utf-8'));
        return Array.isArray(parsed.designs) && parsed.designs.length > 0;
    } catch (err: unknown) {
        const error = toError(err);
        console.warn(`⚠️  Skipping unparseable ${designPath}: ${error.message}`);
        return false;
    }
}
