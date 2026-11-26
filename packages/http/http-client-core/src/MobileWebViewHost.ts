/**
 * A shell's serialized bootstrap acknowledgement, supplied before constructing HTTP clients.
 * This is configuration, not authentication or proof that a function runs natively. The adapter
 * must bind this identity to its native session and enforce it on every request and reply.
 */
export class MobileWebViewHost {
    constructor(
        readonly kind: 'expo-webview' | 'react-native-webview',
        readonly protocolVersion: 1,
        readonly documentId: string,
        readonly sessionId: string,
        readonly nativeHttp: true,
        readonly nativeDeadlines: true,
        readonly nativeCancellation: true,
    ) {}

    /** Validate plain JavaScript / deserialized bootstrap data as well as typed callers. */
    // webpieces-disable no-function-outside-class -- validate the serialized bootstrap contract
    static missingCapabilities(host: MobileWebViewHost): string[] {
        const missing: string[] = [];
        if (host.kind !== 'expo-webview' && host.kind !== 'react-native-webview')
            missing.push('host kind');
        if (host.protocolVersion !== 1) missing.push('protocolVersion=1');
        if (typeof host.documentId !== 'string' || !host.documentId.trim())
            missing.push('documentId');
        if (typeof host.sessionId !== 'string' || !host.sessionId.trim()) missing.push('sessionId');
        if (host.nativeHttp !== true) missing.push('nativeHttp');
        if (host.nativeDeadlines !== true) missing.push('nativeDeadlines');
        if (host.nativeCancellation !== true) missing.push('nativeCancellation');
        return missing;
    }
}

/** A mobile shell has not negotiated the native HTTP implementation required by #1463. */
export class MobileWebViewRuntimeConfigError extends Error {
    static readonly ISSUE_URL = 'https://github.com/deanhiller/webpieces-ts/issues/1463';

    constructor(readonly missing: readonly string[]) {
        super(
            'Expo/native HTTP client required for a React Native WebView: ' +
                `missing or incompatible: ${missing.join(', ')}. ` +
                'Complete shell bootstrap, then pass HttpClientRuntime.mobileWebView(fetch, deadlines, host) ' +
                'with native-backed HTTP, end-to-end deadlines and cancellation. Browser fetch/timers can ' +
                `stall while locked. Reason: ${MobileWebViewRuntimeConfigError.ISSUE_URL}`,
        );
        this.name = 'MobileWebViewRuntimeConfigError';
    }
}
