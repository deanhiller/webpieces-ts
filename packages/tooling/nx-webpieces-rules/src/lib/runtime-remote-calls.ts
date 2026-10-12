/**
 * Remote service calls in the runtime graph (#1203)
 *
 * A `uses` whose named target (the call-site `targetService`, else the caller's `callsService`) is a
 * REVIEWED remote service — declared in dependencies.json `remoteServices`, outside this workspace —
 * is claimed here instead of being resolved against the workspace's own nodes. Without this the call
 * either decayed into an "unresolved" vendor box (nothing in-repo implements the contract) or failed as
 * a name no module answers to (something in-repo does).
 *
 * Workspace names always win: a remote name that collides with a node is reported as a problem and
 * never claims the call, so a stray declaration cannot redirect a call away from a real module.
 */

import type { ApiRef, ApiTransport } from './api-usage/api-relations';
import type { RemoteServiceApi, RemoteServices } from './remote-services';
import type { RuntimeGraph, RuntimeRemoteCall, RuntimeRemoteService } from './runtime-graph-model';

export class RemoteCallCollector {
    /** remote name -> "caller transport" -> contracts called there. */
    private readonly calls = new Map<string, Map<string, Set<string>>>();

    constructor(
        private readonly remotes: RemoteServices,
        /** True when a workspace runtime node answers to the name. */
        private readonly isWorkspaceName: (name: string) => boolean,
        private readonly problems: string[],
    ) {
        for (const name of Object.keys(remotes).sort())
            if (isWorkspaceName(name))
                problems.push(
                    `remoteServices declares '${name}', but a workspace module already answers to that name — a remote ` +
                        `service must live OUTSIDE this workspace. Remove the remoteServices entry or rename one of them.`,
                );
    }

    /**
     * True when `wanted` names a declared remote service, which then owns this use. A remote that does
     * not declare the contract + transport is a problem; the call is still drawn to it, so the picture
     * shows exactly what the declaration is missing.
     */
    claim(user: string, ref: ApiRef, wanted: string | undefined): boolean {
        if (wanted === undefined) return false;
        const remote = this.remotes[wanted];
        if (remote === undefined || this.isWorkspaceName(wanted)) return false;
        if (!remote.implementsApi(ref.api, ref.type))
            this.problems.push(
                `${user} calls "${ref.api}" (${ref.type}) at remote service '${wanted}', but remoteServices.${wanted}.implements ` +
                    `does not declare it. Add { "api": "${ref.api}", "type": "${ref.type}" } after review, or fix the target.`,
            );
        let byCaller = this.calls.get(wanted);
        if (byCaller === undefined) {
            byCaller = new Map<string, Set<string>>();
            this.calls.set(wanted, byCaller);
        }
        const key = `${user} ${ref.type}`;
        if (!byCaller.has(key)) byCaller.set(key, new Set<string>());
        byCaller.get(key)!.add(ref.api);
        return true;
    }

    /** Every DECLARED remote service, called or not, onto the graph. Absent when none are declared. */
    attach(graph: RuntimeGraph): void {
        const names = Object.keys(this.remotes).sort();
        if (names.length === 0) return;
        const remoteServices: Record<string, RuntimeRemoteService> = {};
        for (const name of names) {
            const decl = this.remotes[name];
            remoteServices[name] = {
                label: decl.label,
                implements: decl.implements.map(
                    (entry: RemoteServiceApi) => `${entry.api} (${entry.type})`,
                ),
                calledBy: this.calledBy(name),
            };
        }
        graph.remoteServices = remoteServices;
    }

    private calledBy(name: string): RuntimeRemoteCall[] {
        const byCaller = this.calls.get(name) ?? new Map<string, Set<string>>();
        return [...byCaller.keys()].sort().map((key: string): RuntimeRemoteCall => {
            const parts = key.split(' ');
            return {
                from: parts[0],
                via: [...byCaller.get(key)!].sort(),
                type: parts[1] as ApiTransport,
            };
        });
    }
}
