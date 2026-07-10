/**
 * API Relations Validator
 *
 * Enforces that the dependency graph is TRUTHFUL: a runnable project (role server
 * or client) that compiles against an api-lib must actually IMPLEMENT (serve) or
 * USE (call) at least one of its APIs. A dependency that is neither is almost
 * always a mistake — a forgotten client wiring, a dead import, or a controller
 * that was never registered — and it would draw an unexplained edge in the graph.
 *
 * The check reuses the same source scan that produces `apiRelations`, so "does P
 * relate to api-lib D" is answered by real code, never a declaration.
 */

import type { EnhancedGraph } from '../graph-sorter';
import { ProjectInfo } from '../project-info';
import { resolveRole } from '../role-resolver';
import { ApiScanResult } from './api-scanner';

/** Roles that must justify every api-lib dependency (top-level runnables). */
const CHECKED_ROLES: ReadonlyArray<string> = ['server', 'client'];

/** One `role:server`/`role:client` project that depends on an api-lib it neither implements nor uses. */
export interface UnclassifiedApiDep {
    project: string;
    role: string;
    apiLib: string;
    /** The API contract class names that api-lib exports (for the fix hint). */
    apis: string[];
}

/** The API class names owned by `apiLib`, sorted (for a stable fix hint). */
// webpieces-disable no-function-outside-class -- pure lookup helper, matches the validator-lib style
function apisOwnedBy(scan: ApiScanResult, apiLib: string): string[] {
    const names: string[] = [];
    for (const info of scan.apiIndex.values()) {
        if (info.owner === apiLib) names.push(info.api);
    }
    return names.sort();
}

/**
 * Every server/client → api-lib edge for which the scan found NO implements and
 * NO uses. `graph` must already carry `apiRelations` (call scanAndAttachApiRelations first).
 */
// webpieces-disable no-function-outside-class -- module entry point, mirrors findUnclassified-style validators
export function findUnclassifiedApiDeps(
    graph: EnhancedGraph,
    projectInfos: Map<string, ProjectInfo>,
    scan: ApiScanResult,
): UnclassifiedApiDep[] {
    const violations: UnclassifiedApiDep[] = [];
    for (const projectName of Object.keys(graph)) {
        const info = projectInfos.get(projectName);
        if (!info) continue;
        const role = resolveRole(info).role;
        if (role === null || !CHECKED_ROLES.includes(role)) continue;
        // Only flag projects whose production source was actually scanned. An all-test project
        // (e.g. an e2e harness whose only files are *.spec.ts) is never observed, so we can't
        // conclude its api-lib dependency is unused.
        if (!scan.scannedProjects.has(projectName)) continue;

        const entry = graph[projectName];
        for (const dep of entry.dependsOn) {
            if (!scan.apiLibProjects.has(dep)) continue;
            if (entry.apiRelations && entry.apiRelations[dep]) continue;
            violations.push({ project: projectName, role, apiLib: dep, apis: apisOwnedBy(scan, dep) });
        }
    }
    return violations;
}

/** Human-readable, fix-oriented report for one unclassified dependency. */
// webpieces-disable no-function-outside-class -- pure formatter, matches the validator-lib style
export function describeUnclassifiedApiDep(violation: UnclassifiedApiDep): string {
    const apiHint = violation.apis.length > 0 ? violation.apis.join(', ') : 'the API';
    const theApi = violation.apis[0] ?? 'TheApi';
    const lines = [
        `  ❌ '${violation.project}' (role:${violation.role}) depends on api-lib '${violation.apiLib}' ` +
            `but neither IMPLEMENTS nor USES any of its APIs (${apiHint}).`,
        `     Do ONE of:`,
        `       1. USE it as a client: inject ClientHttpFactory (@webpieces/http-client-node) or ` +
            `ClientHttpBrowserFactory (@webpieces/http-client-browser) and call ` +
            `factory.createRpcClient(${theApi}, config); for a @PubSub api use ` +
            `ClientCloudTasksFactory.createPubSubClient(${theApi}, config).`,
        `       2. IMPLEMENT it: add a controller and register it — ` +
            `apiFactory.addRoutes(${theApi}, TheController).`,
        `       3. If the dependency is unused, remove '${violation.apiLib}' from '${violation.project}'.`,
    ];
    return lines.join('\n');
}
