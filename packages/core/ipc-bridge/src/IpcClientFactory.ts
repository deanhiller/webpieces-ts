import { ApiCallSite, ApiImplementationError } from '@webpieces/core-util/errors';
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
        const apiName = apiClass.name || apiId;
        for (const [key, methodId] of Object.entries(endpoints)) {
            // Same call-site capture as the HTTP clients (#1175): synchronous on the CALLER's stack,
            // trimmed at `clientMethod`, parked on the SAME rejected instance.
            // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
            const clientMethod = (request: unknown): Promise<unknown> => {
                const callSite = ApiCallSite.capture(apiName, key, clientMethod);
                // webpieces-disable no-any-unknown -- a rejection value is genuinely unknown
                return this.call(apiClass, apiId, methodId, key, request).catch((failure: unknown) => {
                    callSite.attachTo(failure);
                    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrows the caller's own failure unchanged
                    throw failure;
                });
            };
            methods.set(key, clientMethod);
        }
        return new Proxy(Object.create(null) as T, new IpcProxyHandler(methods));
    }

    /** One IPC request/reply, logged; the body of every generated IPC client method. */
    private async call<T extends object>(
        apiClass: IpcApiType<T>,
        apiId: string,
        methodId: string,
        key: string,
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        request: unknown,
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    ): Promise<unknown> {
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
