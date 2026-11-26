import { DeadlineScheduler, TimerDeadlineScheduler } from '@webpieces/core-util';
import { MobileWebViewHost, MobileWebViewRuntimeConfigError } from './MobileWebViewHost';

/**
 * The options ONE generated-client transmission hands its {@link HttpFetch}. A class rather than a
 * `RequestInit` literal so every field the client sends is named in one place; it is structurally a
 * subset of the DOM `RequestInit` AND of Expo's `FetchRequestInit`, which is what lets `globalThis.fetch`
 * and `import { fetch } from 'expo/fetch'` both be passed as an {@link HttpFetch} with no cast.
 */
export class HttpFetchInit {
    constructor(
        readonly method: string,
        readonly headers: Record<string, string>,
        readonly signal: AbortSignal,
        /** `manual` for a `full` response or a filter that follows redirects itself; else `follow`. */
        readonly redirect: 'manual' | 'follow',
        /** The exact serialized body; absent for a call with no argument. */
        readonly body?: string,
    ) {}
}

/**
 * A fetch-compatible function: the ONLY thing a generated client calls to put a request on the wire.
 * `globalThis.fetch` and Expo's `expo/fetch` (whose `FetchResponse` implements `Response`) both satisfy
 * it as-is. Any other native-backed transport does too, if it accepts these options and resolves a
 * `Response`-compatible object.
 */
export type HttpFetch = (url: string, init: HttpFetchInit) => Promise<Response>;

/** Which runtime a {@link HttpClientRuntime} was built for; see its named constructors. */
export enum HttpRuntimeKind {
    /** Platform fetch + JS timers: standalone browsers, Node, SSR, workers, tests. */
    PLATFORM_DEFAULT = 'platform-default',
    /** The application declared a React Native JS runtime and supplied native-backed collaborators. */
    REACT_NATIVE = 'react-native',
    /** Page HTTP delegates through a declared mobile shell to its native adapter. */
    MOBILE_WEBVIEW = 'mobile-webview',
}

/**
 * The two runtime collaborators of ONE client factory (#1445): how a request reaches the network
 * ({@link HttpFetch}) and where its deadline's clock and wake-up come from ({@link DeadlineScheduler}).
 * Held per factory, never process-wide, so two factories in one app can use different transports and
 * nothing monkey-patches `globalThis.fetch` or the JS timers.
 *
 * - {@link HttpClientRuntime.platformDefaults} — standalone browser/Node/SSR/worker/test: platform fetch,
 *   looked up on EVERY call (so a test's stubbed global is honoured), and standard JS timers.
 * - {@link HttpClientRuntime.reactNative} — the React Native JS runtime, whose default fetch and JS
 *   timers can stop progressing while an Android phone is locked. The application passes a
 *   native-backed fetch (e.g. `expo/fetch`) and a native-backed {@link DeadlineScheduler}; this call is
 *   the explicit capability acknowledgement, because no runtime check can PROVE a function is
 *   background-safe from its name or source text.
 */
export class HttpClientRuntime {
    private constructor(
        readonly kind: HttpRuntimeKind,
        readonly fetch: HttpFetch,
        readonly deadlines: DeadlineScheduler,
        readonly host?: MobileWebViewHost,
    ) {}

    // webpieces-disable no-function-outside-class -- named constructor of an immutable runtime value
    static platformDefaults(): HttpClientRuntime {
        return new HttpClientRuntime(
            HttpRuntimeKind.PLATFORM_DEFAULT,
            // webpieces-disable no-fetch -- this IS the generated-client implementation the rule points everyone to
            (url: string, init: HttpFetchInit): Promise<Response> => fetch(url, init),
            new TimerDeadlineScheduler(),
        );
    }

    /**
     * Declare the React Native JS runtime and its native-backed collaborators. Both are REQUIRED; a
     * caller that reaches here without one (plain JavaScript, or a value that was `undefined` at
     * runtime) is refused with the name of what is missing, before any client is built.
     */
    // webpieces-disable no-function-outside-class -- named constructor of an immutable runtime value
    static reactNative(fetch: HttpFetch, deadlines: DeadlineScheduler): HttpClientRuntime {
        const missing = HttpClientRuntime.missingCollaborators(fetch, deadlines);
        if (missing.length > 0) {
            throw new ReactNativeRuntimeConfigError(missing, 'HttpClientRuntime.reactNative(...)');
        }
        return new HttpClientRuntime(HttpRuntimeKind.REACT_NATIVE, fetch, deadlines);
    }

    /**
     * Declare the page's negotiated mobile host and native-backed adapter. No Expo import belongs
     * in this portable package or in page JS: fetch must cross IPC to native HTTP, not Expo's web
     * fallback. The native side owns resource deadlines even while page JavaScript is suspended.
     */
    // webpieces-disable no-function-outside-class -- named constructor of an immutable runtime value
    static mobileWebView(
        fetch: HttpFetch,
        deadlines: DeadlineScheduler,
        host: MobileWebViewHost,
    ): HttpClientRuntime {
        const missing = HttpClientRuntime.missingCollaborators(fetch, deadlines);
        if (!host) {
            missing.push('shell host capabilities');
        } else {
            missing.push(...MobileWebViewHost.missingCapabilities(host));
        }
        if (missing.length > 0) throw new MobileWebViewRuntimeConfigError(missing);
        return new HttpClientRuntime(
            HttpRuntimeKind.MOBILE_WEBVIEW,
            fetch,
            deadlines,
            Object.freeze(
                new MobileWebViewHost(
                    host.kind,
                    host.protocolVersion,
                    host.documentId,
                    host.sessionId,
                    host.nativeHttp,
                    host.nativeDeadlines,
                    host.nativeCancellation,
                ),
            ),
        );
    }

    // webpieces-disable no-function-outside-class -- pure validation of the two collaborators
    private static missingCollaborators(
        fetch: HttpFetch | undefined,
        deadlines: DeadlineScheduler | undefined,
    ): string[] {
        const missing: string[] = [];
        if (typeof fetch !== 'function') missing.push('fetch');
        if (
            deadlines === undefined ||
            deadlines === null ||
            typeof deadlines.schedule !== 'function' ||
            typeof deadlines.now !== 'function'
        ) {
            missing.push('deadlines');
        }
        return missing;
    }
}

/**
 * A React Native client was configured without the native-backed collaborators it needs. Thrown when
 * the factory/runtime is CREATED — never on a request — so the misconfiguration surfaces at startup
 * instead of as a request that silently stalls while the phone is locked.
 */
export class ReactNativeRuntimeConfigError extends Error {
    /** The reproduction and setup rationale; every message links it. */
    static readonly SETUP_URL = 'https://github.com/deanhiller/webpieces-ts/issues/1463';

    constructor(
        /** The missing collaborator names: `fetch`, `deadlines`, or both. */
        readonly missing: string[],
        /** Where the problem was detected, for the message. */
        readonly site: string,
    ) {
        super(
            `${site}: Expo/native HTTP client required for React Native; missing: ` +
                `${missing.join(', ')}. React Native's default fetch and JS timers can stop while the ` +
                `device is locked. Pass HttpClientRuntime.reactNative(fetch, deadlines) — e.g. ` +
                `\`import { fetch } from 'expo/fetch'\` and a DeadlineScheduler backed by a native timer. ` +
                `Setup: ${ReactNativeRuntimeConfigError.SETUP_URL}`,
        );
        this.name = 'ReactNativeRuntimeConfigError';
    }
}
