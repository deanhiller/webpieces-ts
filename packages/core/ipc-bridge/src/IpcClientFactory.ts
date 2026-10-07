import { ApiImplementationError } from '@webpieces/core-util/errors';
import {
    ClientRole,
    IpcCallContext,
    IpcClientErrorTranslator,
    IpcConnection,
    IpcApiType,
    IpcLogging,
    IpcRequest,
    IpcCallLogger,
    assertInternalApi,
    getIpcEndpoints,
    getIpcMaskSpec,
    MaskSpec,
} from '@webpieces/core-util/ipc';

/** Typed proxies on one trusted duplex connection; no HTTP decorators or container required. */
export class IpcClientFactory {
    /**
     * @param role - WHO receives this factory's replies (see {@link ClientRole}). REQUIRED, with no
     *   default (#1173): it decides what an `unauthorized` reply means. An end-user client (the
     *   WebView or app shell acting for the person) decodes it as `ApiUnauthorizedError` ("log in
     *   again"); a server decodes it as `ApiImplementationError`, because the credential it presented
     *   was its own.
     */
    constructor(
        private readonly connection: IpcConnection,
        private readonly logging: IpcLogging,
        private readonly role: ClientRole,
        private readonly parent?: IpcCallContext,
    ) {}

    /** Explicit scope propagation is safe across concurrent async calls in browser and RN. */
    withContext(context: IpcCallContext): IpcClientFactory {
        return new IpcClientFactory(this.connection, this.logging, this.role, context);
    }

    createClient<T extends object>(apiClass: IpcApiType<T>): T {
        const apiId = assertInternalApi(apiClass);
        const endpoints = getIpcEndpoints(apiClass);
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        const methods = new Map<PropertyKey, (request: unknown) => Promise<unknown>>();
        for (const [key, methodId] of Object.entries(endpoints)) {
            // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
            methods.set(key, async (request: unknown): Promise<unknown> => {
                const context = this.connection.newContext(this.parent);
                return IpcCallLogger.execute(
                    this.logging,
                    context,
                    'client',
                    apiId,
                    methodId,
                    getIpcMaskSpec(apiClass, key) ?? new MaskSpec({}),
                    request,
                    async () => {
                        if (request === null || request === undefined)
                            throw new ApiImplementationError(
                                'IPC requests require one non-null DTO',
                            );
                        const reply = await this.connection.request(
                            new IpcRequest(apiId, methodId, context, request),
                        );
                        // EVERY reply passes the seam, success included, so an app can turn an
                        // apparently-successful reply into a throw. `asserts reply is IpcSuccess`
                        // is what leaves no `type === 'failure'` branch behind here.
                        IpcClientErrorTranslator.throwIfFailure(reply, this.role);
                        return reply.body === null ? undefined : reply.body;
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
