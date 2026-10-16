import { CallMode, ClientRole } from '@webpieces/core-util';
import { ServiceWorkerRouting } from './ServiceWorkerRouting';

/**
 * Per-client STATE for a browser HTTP client — nothing else. A plain class; it extends nothing and
 * is unrelated to the server package's ClientConfig.
 *
 * The base URL is resolved from `svcName` through the global {@link ClientRegistry}: a registered
 * mapping, else the installed deriver, else RELATIVE — i.e. the origin that served the page, which
 * is what a browser app calling its own backend wants and needs NO configuration. Register a mapping
 * only when the backend is somewhere else (an Angular dev server on :4201 reaching :8201). So this
 * config is just the svcName, and an unregistered one never throws.
 *
 * The context store is NOT config: it is a dependency of {@link ClientHttpBrowserFactory}, shared
 * by every client it builds.
 */
export class ClientConfig {
    constructor(
        /** Service name; resolved to a base URL via ClientRegistry (registered at app startup). */
        public readonly svcName: string,
        /**
         * WHO receives this client's responses — {@link ClientRole.SERVER} for a server calling
         * another server, {@link ClientRole.END_USER_CLIENT} for a client acting for a person (a
         * browser bundle, an Expo shell, a remote MCP client). REQUIRED, with no default (#1173): it
         * decides what a received 401 means — "the user must log in again" for an end-user client,
         * "this service's own credential is broken" (a 500 to its caller) for a server — and the
         * right answer is opposite for the two, so no default could be right for both.
         */
        public readonly role: ClientRole,
        /**
         * Whether the user waits on this client's calls (#1293). The same contract may be built twice:
         * once FOREGROUND for the Refresh button, once {@link CallMode.BACKGROUND} for the timer that
         * polls it. A BACKGROUND client's routes carry `hideProgress` and `callMode`, and every
         * failure it rejects with carries `err.callMode === CallMode.BACKGROUND` — the error's class is
         * unchanged. FOREGROUND, the ordinary call, when omitted.
         */
        public readonly callMode: CallMode = CallMode.FOREGROUND,
        /**
         * Whether the page's service worker may intercept these calls. {@link ServiceWorkerRouting.BYPASS}
         * (append `ngsw-bypass=true`) when omitted, so a dropped connection is an `ApiConnectionError`
         * and never Angular's synthetic 504 — see {@link ServiceWorkerRouting}.
         */
        public readonly serviceWorker: ServiceWorkerRouting = ServiceWorkerRouting.BYPASS,
    ) {}
}
