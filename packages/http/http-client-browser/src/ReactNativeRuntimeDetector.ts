/** The one navigator field the detector reads. Typed locally: this package ships no DOM assumption. */
interface NavigatorProduct {
    readonly product?: unknown;
}

/** `globalThis` as the detector reads it — `navigator` may be absent (Node, SSR, some workers). */
interface GlobalWithNavigator {
    readonly navigator?: NavigatorProduct | null;
}

/**
 * Recognizes the React Native JAVASCRIPT runtime (#1445) — not "a page embedded in a WebView".
 *
 * The signal is `navigator.product === 'ReactNative'`, which React Native sets in
 * `Libraries/Core/setUpNavigator.js` (verified on 0.83.10). Deliberately NOT used:
 * - `window` / `document` presence — React Native defines window-like globals, and a WebView page's
 *   JavaScript has a real `window`; neither tells the two apart.
 * - `window.ReactNativeWebView` — present in a WebView PAGE, which runs on the browser engine's fetch
 *   and timers and must keep the browser defaults.
 * - the user agent, or importing `react-native` — this package must stay importable without it.
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
}
