import { ApiErrorCodec, EndpointNotFoundError, InternalError } from '@webpieces/core-util/errors';
import {
    IpcCallContext,
    IpcApiType,
    IpcFailure,
    IpcLogging,
    IpcReply,
    IpcRequest,
    IpcSuccess,
    IpcCallLogger,
    toError,
    assertInternalApi,
    getIpcEndpoints,
    getIpcMaskSpec,
    MaskSpec,
} from '@webpieces/core-util/ipc';

/** Construct a receiver using explicit call context when it needs to make nested outbound calls. */
export interface IpcControllerScope<T> {
    create(context: IpcCallContext): T;
}
class IpcRegistration {
    // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    constructor(readonly invoke: (request: IpcRequest) => Promise<unknown>) {}
}

/** One dispatcher hosts multiple explicitly registered APIs and never enumerates controller members. */
export class IpcServerFactory {
    private readonly registrations = new Map<string, Map<string, IpcRegistration>>();
    constructor(private readonly logging: IpcLogging) {}

    create<T extends object>(apiClass: IpcApiType<T>, controller: T): void {
        this.register(apiClass, () => controller);
    }

    createScoped<T extends object>(apiClass: IpcApiType<T>, scope: IpcControllerScope<T>): void {
        this.register(apiClass, (context: IpcCallContext) => scope.create(context));
    }

    private register<T extends object>(
        apiClass: IpcApiType<T>,
        controller: (context: IpcCallContext) => T,
    ): void {
        const apiId = assertInternalApi(apiClass);
        if (this.registrations.has(apiId))
            throw new InternalError(`Duplicate IPC API registration: ${apiId}`);
        const methods = new Map<string, IpcRegistration>();
        for (const [key, methodId] of Object.entries(getIpcEndpoints(apiClass))) {
            methods.set(
                methodId,
                new IpcRegistration(async (request) => {
                    // Logging wraps validation and invocation; only handle() below encodes exceptions.
                    return IpcCallLogger.execute(
                        this.logging,
                        request.context,
                        'server',
                        apiId,
                        methodId,
                        getIpcMaskSpec(apiClass, key) ?? new MaskSpec({}),
                        request.body,
                        async () => {
                            if (request.body === null || request.body === undefined)
                                throw new InternalError('IPC requests require one non-null DTO');
                            const instance = controller(request.context);
                            const invoke = instance[key as keyof T];
                            if (typeof invoke !== 'function')
                                throw new InternalError(
                                    `IPC implementation is missing ${apiId}.${methodId}`,
                                );
                            const result =
                                await // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
                                (invoke as (request: unknown) => Promise<unknown>).call(
                                    instance,
                                    request.body,
                                );
                            return result;
                        },
                    );
                }),
            );
        }
        this.registrations.set(apiId, methods);
    }

    /** Bootstrap passes this function to the ONE connection's setHandler before sending calls. */
    readonly handle = async (request: IpcRequest): Promise<IpcReply> => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- receiver translates to a failure reply; the generated client reconstructs and throws it
        try {
            const method = this.registrations.get(request.apiId)?.get(request.methodId);
            if (!method) throw new EndpointNotFoundError('Unknown IPC API or method');
            const body = await method.invoke(request);
            return new IpcSuccess(request.context, body === undefined ? null : body);
        } catch (err: unknown) {
            const error = toError(err);
            return new IpcFailure(request.context, ApiErrorCodec.encode(error));
        }
    };
}
