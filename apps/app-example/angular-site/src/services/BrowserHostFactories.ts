import { ClientConfig, ClientRole, ClientHttpBrowserFactory, ClientRegistry, MutableContextStore } from '@webpieces/http-client-browser';
import { EnvironmentConfig } from './EnvironmentConfig';

/**
 * Factory BODIES for the providers BrowserHostBindings registers in src/wiring.ts. The registration
 * (token, factory reference, deps) stays visible in wiring.ts; the work it runs lives here. Arrow
 * fields so Angular can call each one as a plain useFactory function.
 */
export class BrowserHostFactories {
    readonly httpFactory = (store: MutableContextStore): ClientHttpBrowserFactory => new ClientHttpBrowserFactory(store);

    /** Maps the backend's svcName to the dev/prod base URL once, then hands out its ClientConfig. */
    readonly clientConfig = (environment: EnvironmentConfig): ClientConfig => {
        ClientRegistry.addUrlMapping('client-server', environment.apiBaseUrl());
        return new ClientConfig('client-server', ClientRole.END_USER_CLIENT);
    };
}
