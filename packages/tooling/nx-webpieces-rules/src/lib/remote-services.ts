/**
 * Remote services (#1203)
 *
 * The REVIEWED `remoteServices` table of architecture/dependencies.json: services this workspace calls
 * that are NOT Nx projects in it — a service in another repo, a VM, partner endpoints whose host is set
 * per call. Each is keyed by the service name a `uses` relation targets (`targetService`) and lists the
 * contracts it implements, with their transport:
 *
 * ```json
 * "remoteServices": {
 *     "reporter-vm": { "label": "reporter VM", "implements": [{ "api": "ReporterTriggerApi", "type": "rpc" }] }
 * }
 * ```
 *
 * It is approval metadata, exactly like `apiContractFiles`: a human writes it, generation READS it and
 * writes it back unchanged, and nothing ever infers or adds an entry. Absent means "this workspace calls
 * no service outside itself", which is the only reading a repo that never wrote the key can have.
 *
 * The shape is decoded strictly at load time — an unknown key, an empty `implements`, a transport that
 * is not rpc/pubsub — fails the load naming the entry, so a typo can never quietly widen what a `uses`
 * may target.
 */

import { Option, RuleFailError } from '@webpieces/rules-config';

/** The transports a remote service can implement. A vendor (`external`) seam is an externalSystem. */
export type RemoteServiceTransport = 'rpc' | 'pubsub';

/** One contract a remote service implements, with the transport it is served over. */
export class RemoteServiceApi {
    constructor(
        public readonly api: string,
        public readonly type: RemoteServiceTransport,
    ) {}
}

/** One out-of-workspace service: an optional display label and the contracts it implements. */
export class RemoteService {
    /** Never empty: a remote service that implements nothing could be the target of nothing. */
    readonly implements: RemoteServiceApi[];

    constructor(
        /** Display text only; the node identity is the table KEY (the name `uses` targets). */
        public readonly label: string | undefined,
        implementations: RemoteServiceApi[],
    ) {
        this.implements = implementations;
    }

    implementsApi(api: string, type: string): boolean {
        return this.implements.some(
            (entry: RemoteServiceApi) => entry.api === api && entry.type === type,
        );
    }
}

/** service name -> its reviewed declaration. Serialized as the `remoteServices` key of dependencies.json. */
export type RemoteServices = Record<string, RemoteService>;

export const REMOTE_SERVICES_RULE = 'validate-runtime-architecture';

const SERVICE_KEYS = ['label', 'implements'];
const API_KEYS = ['api', 'type'];

/** Strict decoder for the `remoteServices` value of a parsed dependencies.json. */
export class RemoteServicesCodec {
    // webpieces-disable no-any-unknown -- untrusted JSON is narrowed and validated at the input boundary
    decode(value: unknown, fullPath: string): RemoteServices {
        if (value === undefined) return {};
        const table = this.record(value, fullPath, 'remoteServices');
        const services: RemoteServices = {};
        for (const name of Object.keys(table).sort()) {
            const where = `remoteServices.${name}`;
            if (name.trim() === '' || name !== name.trim())
                this.fail(fullPath, `${where}: a remote service name must be a non-empty name without surrounding spaces.`);
            const entry = this.record(table[name], fullPath, where);
            this.onlyKeys(entry, SERVICE_KEYS, fullPath, where);
            const label = entry['label'];
            if (label !== undefined && (typeof label !== 'string' || label.trim() === ''))
                this.fail(fullPath, `${where}.label must be a non-empty string when present.`);
            services[name] = new RemoteService(
                label as string | undefined,
                this.implementations(entry['implements'], fullPath, where),
            );
        }
        return services;
    }

    // webpieces-disable no-any-unknown -- untrusted JSON is narrowed and validated at the input boundary
    private implementations(value: unknown, fullPath: string, where: string): RemoteServiceApi[] {
        if (!Array.isArray(value) || value.length === 0)
            this.fail(
                fullPath,
                `${where}.implements must be a non-empty array of { "api": "<ApiName>", "type": "rpc" | "pubsub" }.`,
            );
        const seen = new Set<string>();
        const result: RemoteServiceApi[] = [];
        (value as unknown[]).forEach((item: unknown, index: number) => {
            const at = `${where}.implements[${index}]`;
            const entry = this.record(item, fullPath, at);
            this.onlyKeys(entry, API_KEYS, fullPath, at);
            const api = entry['api'];
            const type = entry['type'];
            if (typeof api !== 'string' || api.trim() === '')
                this.fail(fullPath, `${at}.api must be the contract's class name (e.g. "ReporterTriggerApi").`);
            if (type !== 'rpc' && type !== 'pubsub')
                this.fail(
                    fullPath,
                    `${at}.type must be "rpc" or "pubsub", got ${JSON.stringify(type)}. A vendor contract is an externalSystem, not a remote service.`,
                );
            if (seen.has(api as string))
                this.fail(fullPath, `${at}: ${String(api)} is declared twice in ${where}.implements.`);
            seen.add(api as string);
            result.push(new RemoteServiceApi(api as string, type));
        });
        return result;
    }

    // webpieces-disable no-any-unknown -- untrusted JSON is narrowed and validated at the input boundary
    private record(value: unknown, fullPath: string, where: string): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            this.fail(fullPath, `${where} must be a JSON object.`);
        return value as Record<string, unknown>;
    }

    // webpieces-disable no-any-unknown -- untrusted JSON is narrowed and validated at the input boundary
    private onlyKeys(entry: Record<string, unknown>, allowed: string[], fullPath: string, where: string): void {
        for (const key of Object.keys(entry))
            if (!allowed.includes(key))
                this.fail(fullPath, `${where}: unknown key "${key}" (allowed: ${allowed.join(', ')}).`);
    }

    private fail(fullPath: string, message: string): never {
        throw new RuleFailError(REMOTE_SERVICES_RULE, `${fullPath}: ${message}`, undefined, undefined, [
            new Option(
                'Fix the reviewed remoteServices entry in architecture/dependencies.json: each key is a service name outside this workspace, mapped to { "label"?: "<display text>", "implements": [{ "api": "<ApiName>", "type": "rpc" | "pubsub" }] }. Generation never writes or infers this table.',
                true,
            ),
        ]);
    }
}
