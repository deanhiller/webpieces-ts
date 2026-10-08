/**
 * Entry points always sit in the top row (#1179).
 *
 * A project's level is its dependency depth, so before this a client could sit at L6 while a server
 * sat at L7, and finding the runnable top-level projects meant scanning several rows. After it, the
 * TOP row of the architecture graph is exactly the servers, clients and apps — and nothing else.
 *
 * The rule, applied once roles are resolved (enrichGraph):
 *
 *   top = max( highest level of any entry point, 1 + highest level of any other non-bundle project )
 *
 * The second term guarantees no library ever shares the top row. Every entry point gets `top`. Then
 * anything that depends on an entry point is re-levelled bottom-up as `1 + max(level of its deps)` —
 * `role-dependency` only lets a `role:bundle` do that, so in a valid graph only bundles move, and they
 * stay above the apps they aggregate.
 *
 * The one entry point that can depend on another is a server orchestrator booting other servers
 * (`role-dependency` allows server → server). It cannot share the row of a server it depends on, so it
 * sits one row higher: `max(top, 1 + max(level of its deps))`. Every dependency therefore still sits
 * STRICTLY below its dependent — the generate executor re-asserts that after promotion.
 *
 * Entry points only ever move UP. The runtime graph is NOT changed: its levels are call depth
 * (client → server → fsdb server), and pinning there would put an fsdb server beside its caller.
 */

import type { EnhancedGraph } from './graph-sorter';

export const BUNDLE_ROLE = 'bundle';

export class EntryPointLevels {
    constructor(
        /** The roles that are entry points — graph-metadata.ts's APP_ROLES (server, app, client). */
        private readonly appRoles: readonly string[],
    ) {}

    /** Re-level `graph` in place. A graph with no entry point is left exactly as it was. */
    promote(graph: EnhancedGraph): void {
        const projects = Object.keys(graph);
        const isApp = (project: string): boolean => this.appRoles.includes(graph[project].role ?? '');
        const apps = projects.filter(isApp);
        if (apps.length === 0) return;

        let top = Math.max(...apps.map((project: string): number => graph[project].level));
        for (const project of projects) {
            if (isApp(project) || graph[project].role === BUNDLE_ROLE) continue;
            top = Math.max(top, graph[project].level + 1);
        }

        // Ascending ORIGINAL level: every dependency sits strictly lower, so it is final before any
        // project that depends on it is visited.
        const order = [...projects].sort(
            (a: string, b: string): number => graph[a].level - graph[b].level || a.localeCompare(b),
        );
        for (const project of order) {
            const entry = graph[project];
            const above = 1 + Math.max(-1, ...entry.dependsOn.map((dep: string): number => graph[dep]?.level ?? -1));
            entry.level = isApp(project) ? Math.max(top, above) : Math.max(entry.level, above);
        }
    }
}
