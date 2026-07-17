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
import { ApiScanResult, UnresolvedApiCall } from './api-scanner';

/** Roles that must justify every api-lib dependency (top-level runnables). */
const CHECKED_ROLES: ReadonlyArray<string> = ['server', 'client'];

/** One `role:server`/`role:client` project that depends on an api-lib it neither implements nor uses. */
export interface UnclassifiedApiDep {
    project: string;
    role: string;
    apiLib: string;
    /** The API contract class names that api-lib exports (for the fix hint). */
    apis: string[];
    /**
     * Contracts this project DOES name at a call site but which never resolved to decorated
     * source. When non-empty the wiring almost certainly exists and the scan is blind — advice
     * to "add a controller" or "remove the dependency" would be actively wrong.
     */
    unresolved: UnresolvedApiCall[];
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
            violations.push({
                project: projectName,
                role,
                apiLib: dep,
                apis: apisOwnedBy(scan, dep),
                unresolved: scan.unresolvedApiCalls.filter((c: UnresolvedApiCall) => c.project === projectName),
            });
        }
    }
    return violations;
}

/**
 * The project DOES wire this contract up — we just couldn't see it, because the import resolved
 * to a decorator-erased declaration file. Report THAT, not a list of dead ends: telling a dev to
 * register a controller they already registered, or to delete a load-bearing dependency, sends
 * them chasing ghosts and gets the whole validator turned off.
 */
// webpieces-disable no-function-outside-class -- pure formatter, matches the validator-lib style
function describeBlindScan(violation: UnclassifiedApiDep): string {
    const lines = [
        `  ❌ '${violation.project}' (role:${violation.role}) depends on api-lib '${violation.apiLib}' and its ` +
            `wiring IS present in source, but the contract could not be read:`,
    ];
    for (const call of violation.unresolved) {
        lines.push(
            `       • ${call.api} at ${call.at} resolved to ${call.declaredIn} (decorators erased in .d.ts).`,
        );
    }
    lines.push(
        `     This is a CONFIG gap, not a wiring gap. Do NOT add a controller and do NOT remove the dependency.`,
        `     Fix: add a tsconfig.base.json 'paths' entry for '${violation.apiLib}' → its src/index.ts,`,
        `     so the import resolves to source instead of dist/.`,
    );
    return lines.join('\n');
}

/** Human-readable, fix-oriented report for one unclassified dependency. */
// webpieces-disable no-function-outside-class -- pure formatter, matches the validator-lib style
export function describeUnclassifiedApiDep(violation: UnclassifiedApiDep): string {
    if (violation.unresolved.length > 0) return describeBlindScan(violation);
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
