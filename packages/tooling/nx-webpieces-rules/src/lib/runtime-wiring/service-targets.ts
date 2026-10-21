import { Option, RuleFailError } from '@webpieces/rules-config';
import type { EnhancedGraph } from '../graph-sorter';
import type {
    ApiContracts,
    ApiRef,
    ExternalSystemDecl,
    ExternalSystemDecls,
} from '../api-usage/api-relations';
import type { RemoteService, RemoteServiceApi, RemoteServices } from '../remote-services';

const MIGRATE_CURE =
    'Migrate canonical src/wiring.ts, tag owners webpieces/webpieces-lib, and review runtime-deps.json candidates before generation. Saved visualizations remain available.';

const REMOTE_CURE =
    'A uses may target a workspace project\'s metadata.webpieces.serviceName, or a service OUTSIDE this workspace declared in the reviewed remoteServices table of architecture/dependencies.json: "remoteServices": { "<serviceName>": { "label"?: "<display text>", "implements": [{ "api": "<ApiName>", "type": "rpc" | "pubsub" }] } }. Generation reads that table and never writes or infers it.';

/**
 * Every approved `uses` target must answer to its name and serve what is asked of it (#1203).
 *
 * A target is either a workspace project's `metadata.webpieces.serviceName`, or a REVIEWED remote
 * service (another repo, a VM, partner endpoints) declared in dependencies.json `remoteServices`. The
 * two name spaces must not overlap: a remote name that is also a workspace serviceName or project
 * would make one name mean two services.
 */
export class ServiceTargetValidator {
    validate(
        graph: EnhancedGraph,
        contracts: ApiContracts,
        externalSystems: ExternalSystemDecls,
        remoteServices: RemoteServices,
    ): void {
        const hosts = this.hosts(graph);
        this.validateRemoteServices(graph, hosts, contracts, remoteServices);
        for (const [name, entry] of Object.entries(graph))
            for (const [owner, relation] of Object.entries(entry.apiRelations ?? {})) {
                // An EXTERNAL_OUTBOUND contract (apiKind 'external') is an outside system's API: a
                // workspace project that implements it would be a server of ours answering for a vendor.
                for (const ref of relation.implements) {
                    if (ref.type === 'external' || contracts[ref.api]?.apiKind === 'external')
                        this.fail(
                            `${name}: implements ${owner}#${ref.api}, an EXTERNAL_OUTBOUND contract. No server in this repo may implement an outside system's API — bind a client to it instead.`,
                        );
                }
                for (const ref of [...relation.implements, ...relation.uses]) {
                    if (
                        ref.type !== 'external' &&
                        (contracts[ref.api]?.owner !== owner ||
                            contracts[ref.api]?.apiKind !== ref.type)
                    )
                        this.fail(`${name}: unknown qualified contract ${owner}#${ref.api}.`);
                }
                for (const ref of relation.uses)
                    this.validateTarget(graph, hosts, externalSystems, remoteServices, name, owner, ref);
            }
    }

    private validateTarget(
        graph: EnhancedGraph,
        hosts: Map<string, string>,
        externalSystems: ExternalSystemDecls,
        remoteServices: RemoteServices,
        name: string,
        owner: string,
        ref: ApiRef,
    ): void {
        const target = ref.targetService;
        if (target === undefined) return;
        if (
            Object.values(externalSystems).some((system: ExternalSystemDecl) =>
                system.apis.includes(ref.api),
            )
        )
            return;
        const provider = hosts.get(target);
        if (provider === undefined) {
            const remote = remoteServices[target];
            if (remote === undefined)
                this.fail(
                    `${name}: target ${target} (for ${owner}#${ref.api} (${ref.type})) is neither a workspace serviceName nor a declared remote service in dependencies.json remoteServices.`,
                    REMOTE_CURE,
                );
            this.assertRemoteImplements(name, owner, ref, target, remote);
            return;
        }
        const implemented = graph[provider].apiRelations?.[owner]?.implements;
        if (!implemented?.some((api: ApiRef) => api.api === ref.api && api.type === ref.type))
            this.fail(`${name}: target ${target} does not implement ${owner}#${ref.api} (${ref.type}).`);
    }

    /** serviceName -> the workspace project declaring it; a name declared twice fails. */
    private hosts(graph: EnhancedGraph): Map<string, string> {
        const hosts = new Map<string, string>();
        for (const [name, entry] of Object.entries(graph)) {
            if (entry.serviceName === undefined) continue;
            if (hosts.has(entry.serviceName))
                this.fail(
                    `Duplicate service identity ${entry.serviceName}: ${hosts.get(entry.serviceName)} and ${name}.`,
                );
            hosts.set(entry.serviceName, name);
        }
        return hosts;
    }

    /** Each declared remote is outside the workspace and implements only approved contracts. */
    private validateRemoteServices(
        graph: EnhancedGraph,
        hosts: Map<string, string>,
        contracts: ApiContracts,
        remoteServices: RemoteServices,
    ): void {
        for (const [remote, decl] of Object.entries(remoteServices)) {
            const host = hosts.get(remote);
            if (host !== undefined)
                this.fail(
                    `remoteServices.${remote} collides with the workspace serviceName of ${host}: a remote service must live OUTSIDE this workspace. Remove the remoteServices entry (targets of ${remote} resolve to ${host}) or rename one of them.`,
                    REMOTE_CURE,
                );
            if (graph[remote] !== undefined)
                this.fail(
                    `remoteServices.${remote} collides with the workspace project ${remote}: a remote service must live OUTSIDE this workspace. Remove the remoteServices entry or rename it.`,
                    REMOTE_CURE,
                );
            for (const api of decl.implements) this.assertApprovedContract(remote, api, contracts);
        }
    }

    private assertApprovedContract(remote: string, api: RemoteServiceApi, contracts: ApiContracts): void {
        const contract = contracts[api.api];
        if (contract === undefined)
            this.fail(
                `remoteServices.${remote}: unknown qualified contract ${api.api} (${api.type}) — no approved architecture/apis/${api.api}.json declares it.`,
                REMOTE_CURE,
            );
        if (contract.apiKind !== api.type)
            this.fail(
                `remoteServices.${remote}: unknown qualified contract ${contract.owner}#${api.api} (${api.type}) — the approved contract is ${contract.apiKind}.`,
                REMOTE_CURE,
            );
    }

    private assertRemoteImplements(
        user: string,
        owner: string,
        ref: ApiRef,
        target: string,
        remote: RemoteService,
    ): void {
        if (remote.implementsApi(ref.api, ref.type)) return;
        const declared = remote.implements
            .map((entry: RemoteServiceApi) => `${entry.api} (${entry.type})`)
            .join(', ');
        this.fail(
            `${user}: remote service ${target} does not implement ${owner}#${ref.api} (${ref.type}); remoteServices.${target}.implements declares only ${declared}.`,
            REMOTE_CURE,
        );
    }

    private fail(message: string, cure: string = MIGRATE_CURE): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(cure, true),
        ]);
    }
}
