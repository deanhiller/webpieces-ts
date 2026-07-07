import { ContextKey } from '../ContextKey';
import { ContextReader } from './ContextReader';

/**
 * HeaderMethods - stateless utility for turning context keys + a ContextReader into
 * the maps the framework needs (outbound transfer, masked log map).
 *
 * Works in both server (Node) and browser environments; a plain `new HeaderMethods()`
 * (no DI). The set of keys is supplied by the caller (from HeaderRegistry).
 */
export class HeaderMethods {
    /** Keys that transfer over the wire (httpHeader set). */
    findTransferKeys(keys: ContextKey[]): ContextKey[] {
        return keys.filter(k => k.httpHeader !== undefined);
    }

    /** Keys whose values are masked in logs (isSecured=true). */
    securedKeys(keys: ContextKey[]): ContextKey[] {
        return keys.filter(k => k.isSecured);
    }

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
                logMap.set(key.name, key.isSecured ? this.maskSecureValue(value) : value);
            }
        }

        return logMap;
    }

    /**
     * Mask a secure value based on its length.
     * - Length > 15: first 3 + "..." + last 3
     * - Length 8-15: first 2 + "..."
     * - Length < 8: "<secure key too short to log>"
     */
    private maskSecureValue(value: string): string {
        const len = value.length;

        if (len < 8) {
            return '<secure key too short to log>';
        } else if (len <= 15) {
            return `${value.substring(0, 2)}...`;
        } else {
            return `${value.substring(0, 3)}...${value.substring(len - 3)}`;
        }
    }
}
