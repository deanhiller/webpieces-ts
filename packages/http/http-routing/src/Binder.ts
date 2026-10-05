import type {
    BindToFluentSyntax,
    ContainerModuleLoadOptions,
    Newable,
    ResolutionContext,
    ServiceIdentifier,
} from 'inversify';
import type { ApiPrototype, ClientFilterDefinition } from '@webpieces/http-client-core';
import { ClientConfig, ClientHttpFactory } from '@webpieces/http-client-node';
import { ClientCloudTasksFactory, TaskClientConfig } from '@webpieces/cloudtasks-client';

/**
 * Options for {@link Binder.createRpcClientAndBind}. Both are optional.
 *
 * `token` is an EXTRA identity, needed only when two clients of the SAME api must coexist (e.g. one
 * per deployment). Omitted, the API class itself is the DI token. `filters` are this client's own
 * outbound filters, exactly as ClientHttpFactory.createRpcClient takes them.
 */
export class ClientBindOptions<T> {
    constructor(
        public readonly token?: ServiceIdentifier<T>,
        public readonly filters?: readonly ClientFilterDefinition[],
    ) {}
}

/**
 * Options for {@link Binder.createPubSubClientAndBind}. A Cloud Tasks client has no outbound filter
 * chain, so its options carry the extra `token` only; omitted, the API class is the DI token.
 */
export class PubSubBindOptions<T> {
    constructor(public readonly token?: ServiceIdentifier<T>) {}
}

/**
 * The Node host's binder, handed to every {@link BindModule}.configure. One object per load:
 * plain Inversify DI plus the three framework registrations that must stay visible in wiring.ts.
 */
export interface Binder {
    /** Plain DI, unchanged Inversify fluent syntax. */
    bind<T>(token: ServiceIdentifier<T>): BindToFluentSyntax<T>;
    /** Creates the RPC client lazily from the already-bound ClientHttpFactory and binds it (singleton). */
    createRpcClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: ClientBindOptions<NoInfer<T>>,
    ): void;
    /** Creates the Cloud Tasks client lazily from the already-bound ClientCloudTasksFactory and binds it (singleton). */
    createPubSubClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: PubSubBindOptions<NoInfer<T>>,
    ): void;
    /** Binds a vendor implementation of an external contract AND records the external-contract graph edge. */
    bindExternal<T extends object>(api: ApiPrototype<T>, impl: Newable<NoInfer<T>>): void;
}

/** The one Node {@link Binder}: wraps the Inversify load setupRuntime opens for each BindModule. */
export class ContainerBinder implements Binder {
    constructor(private readonly options: ContainerModuleLoadOptions) {}

    bind<T>(token: ServiceIdentifier<T>): BindToFluentSyntax<T> {
        return this.options.bind<T>(token);
    }

    createRpcClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: ClientBindOptions<NoInfer<T>>,
    ): void {
        const filters = options?.filters;
        this.options
            .bind<T>(options?.token ?? api)
            .toDynamicValue((context: ResolutionContext) =>
                context
                    .get(ClientHttpFactory)
                    .createRpcClient(api, new ClientConfig(deployment), filters),
            )
            .inSingletonScope();
    }

    createPubSubClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: PubSubBindOptions<NoInfer<T>>,
    ): void {
        this.options
            .bind<T>(options?.token ?? api)
            .toDynamicValue((context: ResolutionContext) =>
                context
                    .get(ClientCloudTasksFactory)
                    .createPubSubClient(api, new TaskClientConfig(deployment)),
            )
            .inSingletonScope();
    }

    bindExternal<T extends object>(api: ApiPrototype<T>, impl: Newable<NoInfer<T>>): void {
        this.options.bind<T>(api).to(impl).inSingletonScope();
    }
}
