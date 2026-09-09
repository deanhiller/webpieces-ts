import { ApiErrorCodec, EndpointNotFoundError, InternalError } from '@webpieces/core-util/errors';
import {
    IpcCallContext,
    IpcContract,
    IpcFailure,
    IpcLogging,
    IpcMethod,
    IpcReply,
    IpcRequest,
    IpcSuccess,
    IpcCallLogger,
    toError,
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

    create<T extends object>(contract: IpcContract<T>, controller: T): void {
        this.register(contract, () => controller);
    }

    createScoped<T extends object>(contract: IpcContract<T>, scope: IpcControllerScope<T>): void {
        this.register(contract, (context) => scope.create(context));
    }

    private register<T extends object>(
        contract: IpcContract<T>,
        controller: (context: IpcCallContext) => T,
    ): void {
        if (this.registrations.has(contract.id))
            throw new InternalError(`Duplicate IPC API registration: ${contract.id}`);
        const methods = new Map<string, IpcRegistration>();
        for (const key of Object.keys(contract.methods)) {
            // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
            const method = contract.methods[key as keyof T] as IpcMethod<unknown, unknown>;
            methods.set(
                method.id,
                new IpcRegistration(async (request) => {
                    // Logging wraps validation and invocation; only handle() below encodes exceptions.
                    return IpcCallLogger.execute(
                        this.logging,
                        request.context,
                        'server',
                        contract.id,
                        method.id,
                        method.mask,
                        request.body,
                        async () => {
                            const body = method.request.parse(request.body);
                            if (body === null || body === undefined)
                                throw new InternalError('IPC requests require one non-null DTO');
                            const instance = controller(request.context);
                            const invoke = instance[key as keyof T];
                            if (typeof invoke !== 'function')
                                throw new InternalError(
                                    `IPC implementation is missing ${contract.id}.${method.id}`,
                                );
                            const result =
                                await // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
                                (invoke as (request: unknown) => Promise<unknown>).call(
                                    instance,
                                    body,
                                );
                            return method.response.parse(result);
                        },
                    );
                }),
            );
        }
        this.registrations.set(contract.id, methods);
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
