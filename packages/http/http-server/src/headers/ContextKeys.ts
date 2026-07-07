import { ContextKey } from '@webpieces/core-util';

/**
 * Framework-level context keys for non-HTTP values stored in RequestContext.
 *
 * These are set by ContextFilter and can be read by downstream filters/controllers.
 * They have no httpHeader (never transferred) and isLogged=false (they hold objects
 * / internal values that must not be serialized into log lines).
 */
export class ContextKeys {
    static readonly METHOD_META = new ContextKey('webpieces:method-meta', undefined, false, /*isLogged*/ false);
    static readonly REQUEST_PATH = new ContextKey('webpieces:request-path', undefined, false, /*isLogged*/ false);
    static readonly HTTP_METHOD = new ContextKey('webpieces:http-method', undefined, false, /*isLogged*/ false);
}
