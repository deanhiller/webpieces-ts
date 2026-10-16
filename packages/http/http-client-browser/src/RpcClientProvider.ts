import { CallMode } from '@webpieces/core-util';
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
     * {@link ClientConfig.role} and {@link ClientConfig.serviceWorker} routing; every bound client
     * takes both from it and only the destination from the binding, so each is stated once, by the
     * app. A bound client is always FOREGROUND: a BACKGROUND client is a second client for the same
     * contract, built at the call site that polls with `factory.createRpcClient(Api,
     * new ClientConfig(svc, role, CallMode.BACKGROUND))`.
     */
    readonly useFactory = (factory: ClientHttpBrowserFactory, config: ClientConfig): T =>
        factory.createRpcClient(
            this.api,
            new ClientConfig(this.destination, config.role, CallMode.FOREGROUND, config.serviceWorker),
        );
}
