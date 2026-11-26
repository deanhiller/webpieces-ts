/** Only the fields used for environment hints; no DOM or RN dependency. */
class NavigatorProduct {
    readonly product?: string;
}

class WebViewBridge {
    readonly postMessage?: (message: string) => void;
}

class WebViewWindow {
    readonly ReactNativeWebView?: WebViewBridge | null;
}

/** These globals may be absent in Node, SSR and workers. */
class GlobalWithNavigator {
    readonly navigator?: NavigatorProduct | null;
    readonly ReactNativeWebView?: WebViewBridge | null;
    readonly window?: WebViewWindow | null;
}

/**
 * Recognizes the React Native JAVASCRIPT runtime (#1445) — not "a page embedded in a WebView".
 *
 * The signal is `navigator.product === 'ReactNative'`, which React Native sets in
 * `Libraries/Core/setUpNavigator.js` (verified on 0.83.10). Deliberately NOT used:
 * - `window` / `document` presence — React Native defines window-like globals, and a WebView page's
 *   JavaScript has a real `window`; neither tells the two apart.
 * - the user agent, or importing `react-native` — this package must stay importable without it.
 *
 * `isWebView()` separately recognizes the generic RN WebView hint. It triggers fail-closed
 * configuration, never claims Expo or native capabilities. Shells without that hint must explicitly
 * supply HttpClientRuntime.mobileWebView(...) before constructing factories.
 *
 * Reads are guarded so Node, SSR, workers and tests (no `navigator`, or one without `product`) are
 * simply "not React Native". A runtime that hides this marker is covered by declaring it explicitly
 * with `HttpClientRuntime.reactNative(...)`.
 */
export class ReactNativeRuntimeDetector {
    static readonly REACT_NATIVE_PRODUCT = 'ReactNative';

    isReactNative(): boolean {
        if (typeof globalThis === 'undefined') return false;
        const navigator = (globalThis as GlobalWithNavigator).navigator;
        if (typeof navigator !== 'object' || navigator === null) return false;
        return navigator.product === ReactNativeRuntimeDetector.REACT_NATIVE_PRODUCT;
    }

    isWebView(): boolean {
        if (typeof globalThis === 'undefined') return false;
        const globals = globalThis as GlobalWithNavigator;
        return (
            typeof globals.ReactNativeWebView?.postMessage === 'function' ||
            typeof globals.window?.ReactNativeWebView?.postMessage === 'function'
        );
    }
}
