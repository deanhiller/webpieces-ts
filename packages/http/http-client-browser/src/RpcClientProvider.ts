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

    /**
     * The app's own DI-provided {@link ClientConfig} is where this browser host DECLARED its
     * {@link ClientConfig.role}; every bound client takes the role from it and only the destination
     * from the binding, so the role is stated once, by the app, with no default.
     */
    readonly useFactory = (factory: ClientHttpBrowserFactory, config: ClientConfig): T =>
        factory.createRpcClient(this.api, new ClientConfig(this.destination, config.role));
}
