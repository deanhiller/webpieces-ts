import { ApiErrorCodec, InternalError } from '@webpieces/core-util/errors';
import {
    IpcCallContext,
    IpcConnection,
    IpcContract,
    IpcLogging,
    IpcMethod,
    IpcRequest,
    IpcCallLogger,
} from '@webpieces/core-util/ipc';

/** Typed proxies on one trusted duplex connection; no HTTP decorators or container required. */
export class IpcClientFactory {
    constructor(
        private readonly connection: IpcConnection,
        private readonly logging: IpcLogging,
        private readonly parent?: IpcCallContext,
    ) {}

    /** Explicit scope propagation is safe across concurrent async calls in browser and RN. */
    withContext(context: IpcCallContext): IpcClientFactory {
        return new IpcClientFactory(this.connection, this.logging, context);
    }

    createClient<T extends object>(contract: IpcContract<T>): T {
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        const methods = new Map<PropertyKey, (request: unknown) => Promise<unknown>>();
        for (const key of Object.keys(contract.methods)) {
            // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
            const method = contract.methods[key as keyof T] as IpcMethod<unknown, unknown>;
            // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
            methods.set(key, async (request: unknown): Promise<unknown> => {
                const context = this.connection.newContext(this.parent);
                return IpcCallLogger.execute(
                    this.logging,
                    context,
                    'client',
                    contract.id,
                    method.id,
                    method.mask,
                    request,
                    async () => {
                        const body = method.request.parse(request);
                        if (body === null || body === undefined)
                            throw new InternalError('IPC requests require one non-null DTO');
                        const reply = await this.connection.request(
                            new IpcRequest(contract.id, method.id, context, body),
                        );
                        if (reply.type === 'failure') throw ApiErrorCodec.decode(reply.error);
                        return method.response.parse(reply.body);
                    },
                );
            });
        }
        return new Proxy(Object.create(null) as T, new IpcProxyHandler(methods));
    }
}

class IpcProxyHandler<T extends object> implements ProxyHandler<T> {
    constructor(
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        private readonly methods: ReadonlyMap<PropertyKey, (request: unknown) => Promise<unknown>>,
    ) {}
    // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    get(_target: T, key: string | symbol): unknown {
        // Promise assimilation, inspection, symbols and framework instrumentation aren't RPC methods.
        return this.methods.get(key);
    }
    has(_target: T, key: string | symbol): boolean {
        return this.methods.has(key);
    }
}
