import { DeadlineScheduler, TimerDeadlineScheduler } from '@webpieces/core-util';
import { HttpClientRuntime, HttpFetch } from './HttpClientRuntime';
import { MobileWebViewHost } from './MobileWebViewHost';

/**
 * The shape of Expo SDK 55's `expo/fetch` (`build/winter/fetch/fetch.d.ts` + `fetch.types.d.ts`),
 * restated locally because this package must never depend on Expo:
 * `fetch(input: string | URL | FetchRequestLike, init?: FetchRequestInit): Promise<FetchResponse>`,
 * where `FetchResponse implements Response`.
 */
class ExpoShapedInit {
    body?: string | Uint8Array | null;
    credentials?: 'include' | 'omit' | 'same-origin';
    headers?: Record<string, string> | [string, string][];
    method?: string;
    signal?: AbortSignal | null;
    redirect?: 'error' | 'follow' | 'manual';
    keepalive?: boolean;
    integrity?: string;
    referrer?: string;
}
class ExpoShapedResponse extends Response {}
declare const expoShapedFetch: (
    input: string | URL,
    init?: ExpoShapedInit,
) => Promise<ExpoShapedResponse>;
declare const nativeDeadlines: DeadlineScheduler;

/**
 * Compiled by tsc (spec files are not), never executed. Pins that the platform fetch and Expo's
 * `expo/fetch` are BOTH an {@link HttpFetch} with no cast (#1445), and that a React Native runtime
 * cannot be declared without both collaborators. tsc fails with TS2578 if a bad case ever compiles.
 */
class HttpClientRuntimeCompileAssertions {
    platformAndExpoFetchNeedNoCast(): void {
        const platform: HttpFetch = fetch;
        const expo: HttpFetch = expoShapedFetch;
        void HttpClientRuntime.reactNative(expo, nativeDeadlines);
        void HttpClientRuntime.reactNative(platform, new TimerDeadlineScheduler());
    }

    reactNativeNeedsBothCollaborators(): void {
        // @ts-expect-error a React Native runtime needs a native-backed DeadlineScheduler too
        void HttpClientRuntime.reactNative(expoShapedFetch);
        // @ts-expect-error the runtime is built by platformDefaults() / reactNative(...), never `new`
        void new HttpClientRuntime();
    }

    webViewRequiresNegotiatedNativeCapabilities(): void {
        const host = new MobileWebViewHost(
            'expo-webview',
            1,
            'document',
            'session',
            true,
            true,
            true,
        );
        void HttpClientRuntime.mobileWebView(expoShapedFetch, nativeDeadlines, host);
        // @ts-expect-error a WebView runtime requires a shell acknowledgement
        void HttpClientRuntime.mobileWebView(expoShapedFetch, nativeDeadlines);
        // @ts-expect-error unsupported bootstrap versions must be negotiated before client construction
        void new MobileWebViewHost('expo-webview', 2, 'document', 'session', true, true, true);
        // @ts-expect-error native deadlines cannot be omitted/disabled in a declared mobile host
        void new MobileWebViewHost('expo-webview', 1, 'document', 'session', true, false, true);
    }
}
void HttpClientRuntimeCompileAssertions;
