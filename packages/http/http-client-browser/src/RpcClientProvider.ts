import type { ApiPrototype } from '@webpieces/http-client-core';
import { ClientHttpBrowserFactory } from './ClientHttpBrowserFactory';
import { ClientConfig } from './ClientConfig';

/** Structurally compatible Angular factory provider. The original token remains overrideable. */
export class RpcClientProvider<T extends object> {
    readonly deps = [ClientHttpBrowserFactory, ClientConfig];

    constructor(
        public readonly provide: ApiPrototype<T> | symbol,
        private readonly api: ApiPrototype<T>,
        private readonly destination: string,
    ) {}

    readonly useFactory = (factory: ClientHttpBrowserFactory, _config: ClientConfig): T =>
        factory.createRpcClient(this.api, new ClientConfig(this.destination));
}

// webpieces-disable no-function-outside-class -- declarative framework integration seam
export function provideRpcClient<T extends object>(
    token: ApiPrototype<NoInfer<T>> | symbol,
    api: ApiPrototype<T>,
    destination: string,
): RpcClientProvider<T> {
    return new RpcClientProvider(token, api, destination);
}
