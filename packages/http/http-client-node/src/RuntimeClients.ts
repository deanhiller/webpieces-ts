import type { ContainerModuleLoadOptions, ServiceIdentifier } from 'inversify';
import type { ApiPrototype, ClientFilterDefinition } from '@webpieces/http-client-core';
import { ClientToken } from '@webpieces/http-client-core';
import { ClientHttpFactory } from './ClientHttpFactory';
import { ClientConfig } from './ClientConfig';

/** Registers factories only. Overrides loaded afterward never resolve the production factory. */
export class RuntimeClients {
    constructor(private readonly options: ContainerModuleLoadOptions) {}

    bindRpc<T extends object>(
        token: ServiceIdentifier<NoInfer<T>> | ClientToken<NoInfer<T>>,
        api: ApiPrototype<T>,
        destination: string,
        filters?: readonly ClientFilterDefinition[],
    ): void {
        this.options
            .bind<T>(token instanceof ClientToken ? token.identifier : token)
            .toDynamicValue((context) =>
                context
                    .get(ClientHttpFactory)
                    .createRpcClient(api, new ClientConfig(destination), filters),
            )
            .inSingletonScope();
    }
}
