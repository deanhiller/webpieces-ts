import { ContextKey } from '@webpieces/core-util';

/**
 * Framework-level context keys for non-HTTP values stored in RequestContext.
 *
 * These are set by ContextFilter and can be read by downstream filters/controllers.
 * Unlike PlatformHeader, these don't correspond to HTTP headers.
 */
export class ContextKeys {
    static readonly METHOD_META = new ContextKey('webpieces:method-meta');
    static readonly REQUEST_PATH = new ContextKey('webpieces:request-path');
    static readonly HTTP_METHOD = new ContextKey('webpieces:http-method');
}
