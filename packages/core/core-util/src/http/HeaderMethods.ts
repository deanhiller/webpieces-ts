import { ContextKey } from '../ContextKey';
import { ContextReader } from './ContextReader';

/**
 * HeaderMethods - stateless utility for building the masked LOG map from context
 * keys + a ContextReader.
 *
 * This is the BROWSER-safe path: ContextMgr.buildHeadersForLogging (→ ProxyClient)
 * uses it with the browser's MutableContextStore, where there is no RequestContext.
 * The Node loggers (bunyan/winston) do NOT use this — they read RequestContext
 * directly and mask via {@link ContextKey.maskIfSecured} inline.
 *
 * Works in both server (Node) and browser environments; a plain `new HeaderMethods()`
 * (no DI). The set of keys is supplied by the caller (from HeaderRegistry).
 */
export class HeaderMethods {
    /**
     * Build the map for LOGGING from the given keys: each logged key (isLogged=true)
     * with a value present is added under its `name`, masked when isSecured.
     */
    buildSecureMapForLogs(keys: ContextKey[], contextReader: ContextReader): Map<string, string> {
        const logMap = new Map<string, string>();

        for (const key of keys) {
            if (!key.isLogged) {
                continue; // never logged (e.g. recorder, method-meta)
            }
            const value = contextReader.read(key);
            if (value) {
                logMap.set(key.name, key.maskIfSecured(value));
            }
        }

        return logMap;
    }
}
