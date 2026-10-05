import type { ApiPrototype } from '@webpieces/http-client-core';
import type { BrowserToken } from './BrowserProviders';
import { ClientHttpBrowserFactory } from './ClientHttpBrowserFactory';
import { ClientConfig } from './ClientConfig';

/**
 * Structurally compatible Angular factory provider, created by Binder.createRpcClientAndBind. The
 * token remains overrideable and the client is created lazily, on first inject.
 */
export class RpcClientProvider<T extends object> {
    readonly deps = [ClientHttpBrowserFactory, ClientConfig];

    constructor(
        public readonly provide: BrowserToken,
        private readonly api: ApiPrototype<T>,
        private readonly destination: string,
    ) {}

    readonly useFactory = (factory: ClientHttpBrowserFactory, _config: ClientConfig): T =>
        factory.createRpcClient(this.api, new ClientConfig(this.destination));
}
