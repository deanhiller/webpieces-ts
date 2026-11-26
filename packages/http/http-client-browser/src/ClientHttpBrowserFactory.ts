import { assertNotInternalApi, ContextMgr, DocumentDesign } from '@webpieces/core-util';
import {
    ApiPrototype,
    buildClientProxy,
    HttpClientRuntime,
    HttpRuntimeKind,
    ReactNativeRuntimeConfigError,
    MobileWebViewRuntimeConfigError,
} from '@webpieces/http-client-core';
import { BrowserProxyClient } from './BrowserProxyClient';
import { ClientConfig } from './ClientConfig';
import { MutableContextStore } from './MutableContextStore';
import { RequestLifecycleListener } from './RequestLifecycleListener';
import { ReactNativeRuntimeDetector } from './ReactNativeRuntimeDetector';

/**
 * ClientHttpBrowserFactory - builds type-safe HTTP clients for a BROWSER from API prototypes
 * carrying @ApiPath/@Endpoint decorators.
 *
 * Deliberately a plain class with NO decorators and NO inversify: this package may be bundled by
 * React just as easily as by Angular, and neither should be forced to adopt a Node DI container.
 * The app provides it through whatever DI it already has — Angular's `useFactory`, a React context,
 * or a module-level `const`.
 *
 * The factory holds the ONE collaborator every browser client shares (the app's
 * {@link MutableContextStore}); each {@link ClientConfig} holds only that one client's base URL.
 *
 * ```typescript
 * // once, at startup (after HeaderRegistry.configure(...)):
 * const store = new MutableContextStore();
 * const factory = new ClientHttpBrowserFactory(store);
 *
 * const saveApi = factory.createRpcClient(SaveApi, new ClientConfig('server', ClientRole.END_USER_CLIENT));
 * const response = await saveApi.save({ query: 'test' }); // type-safe
 *
 * // later, when the user logs in / picks a tenant — every subsequent call carries them:
 * store.set(AppHeaders.AUTHORIZATION, token);   // an app-defined key, if it wants auto-attach
 * store.set(CompanyHeaders.TENANT_ID, tenantId);
 * ```
 *
 * A browser cannot hold service credentials, so a contract with an oidcSameProject() / oidcSvcs(...) or sharedSecret(...)
 * endpoint throws in `createRpcClient`, not on the first call.
 *
 * **Runtime (#1445).** The optional third argument is this factory's {@link HttpClientRuntime}: the
 * fetch every client it builds sends through and the clock their deadlines use. Omitted, a
 * standalone browser gets the platform fetch and JS timers. In the React Native JS
 * runtime (detected by `navigator.product === 'ReactNative'`) omitting it — or passing
 * `HttpClientRuntime.platformDefaults()` — THROWS {@link ReactNativeRuntimeConfigError} here, before
 * any request, because React Native's default fetch and JS timers can stop while a phone is locked:
 *
 * ```typescript
 * import { fetch as expoFetch } from 'expo/fetch';
 * const factory = new ClientHttpBrowserFactory(
 *     store,
 *     listener,
 *     HttpClientRuntime.reactNative(expoFetch, nativeDeadlineScheduler),
 * );
 * ```
 */
@DocumentDesign()
export class ClientHttpBrowserFactory {
    private readonly contextMgr: ContextMgr;
    private readonly runtime: HttpClientRuntime;

    constructor(
        store: MutableContextStore,
        private readonly lifecycleListener?: RequestLifecycleListener,
        runtime?: HttpClientRuntime,
    ) {
        this.contextMgr = new ContextMgr(store);
        this.runtime = ClientHttpBrowserFactory.selectRuntime(
            runtime,
            new ReactNativeRuntimeDetector(),
        );
    }

    /**
     * The supplied runtime, else the platform defaults — unless this is the React Native JS runtime,
     * where only an explicit {@link HttpClientRuntime.reactNative} is accepted. An embedded RN
     * WebView separately requires {@link HttpClientRuntime.mobileWebView} and shell capabilities.
     */
    // webpieces-disable no-function-outside-class -- pure construction-time selection
    private static selectRuntime(
        runtime: HttpClientRuntime | undefined,
        detector: ReactNativeRuntimeDetector,
    ): HttpClientRuntime {
        if (runtime?.kind !== HttpRuntimeKind.REACT_NATIVE && detector.isReactNative()) {
            throw new ReactNativeRuntimeConfigError(
                ['fetch', 'deadlines'],
                'new ClientHttpBrowserFactory(...)',
            );
        }
        if (runtime?.kind !== HttpRuntimeKind.MOBILE_WEBVIEW && detector.isWebView()) {
            throw new MobileWebViewRuntimeConfigError([
                'declared shell host',
                'nativeHttp',
                'nativeDeadlines',
                'nativeCancellation',
            ]);
        }
        return runtime ?? HttpClientRuntime.platformDefaults();
    }

    /**
     * Create a type-safe HTTP client for one API contract.
     *
     * @param apiPrototype - The API prototype class with @ApiPath/@Endpoint decorators
     * @param config - This client's state (its baseUrl)
     */
    createRpcClient<T extends object>(apiPrototype: ApiPrototype<T>, config: ClientConfig): T {
        // Also catch a shell marker installed after the factory, before binding a client.
        ClientHttpBrowserFactory.selectRuntime(this.runtime, new ReactNativeRuntimeDetector());
        assertNotInternalApi(apiPrototype, 'ClientHttpBrowserFactory');
        const proxyClient = new BrowserProxyClient(
            this.contextMgr,
            this.runtime,
            this.lifecycleListener,
        );
        proxyClient.init(apiPrototype, config);
        return buildClientProxy(apiPrototype, proxyClient);
    }
}
