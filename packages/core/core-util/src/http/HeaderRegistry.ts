import { ContextKey } from '../ContextKey';
import { WebpiecesCoreHeaders } from './WebpiecesCoreHeaders';

/**
 * HeaderRegistry - the single, GLOBAL source of truth for every ContextKey the
 * platform knows about. Port of Java webpieces' HeaderTranslation.
 *
 * Configured exactly like {@link LogManager} — once, at process startup — and then
 * globally accessible. There is NO DI wiring: filters/clients call
 * `HeaderRegistry.get()` instead of injecting it.
 *
 * ```ts
 * // startup (server AND browser), BEFORE LogManager.setFactory(...):
 * HeaderRegistry.configure(AppHeaders.getAllHeaders(), CompanyHeaders.getAllHeaders(), true);
 * ```
 *
 * - `svrHeaders`      this server's own keys.
 * - `companyHeaders`  keys from a shared company lib all services use.
 * - `platformHeaders` when true, also include {@link HeaderRegistry.DEFAULT_HEADERS}
 *                     (the webpieces common keys: request-id, correlation-id, ...).
 *
 * Duplicate validation (port of Java checkForDuplicates) runs at configure() time,
 * so conflicting definitions fail fast at startup:
 * - Two keys with the same `name` must agree on httpHeader/isSecured/isLogged.
 * - Two keys with the same `httpHeader` must agree on `name`.
 * - Exact duplicates collapse to one entry.
 */
export class HeaderRegistry {
    /** The webpieces-supplied common keys; included when platformHeaders=true. */
    static readonly DEFAULT_HEADERS: ContextKey[] = WebpiecesCoreHeaders.getAllHeaders();

    private static instance: HeaderRegistry | undefined;

    private readonly keys: ContextKey[];

    private constructor(keys: ContextKey[]) {
        this.keys = this.checkForDuplicates(keys);
    }

    /**
     * Install the process-wide registry. Call once at startup, BEFORE
     * LogManager.setFactory(...) (logging masks/keys off this registry).
     */
    static configure(svrHeaders: ContextKey[], companyHeaders: ContextKey[], platformHeaders: boolean): void {
        const all: ContextKey[] = [
            ...(platformHeaders ? HeaderRegistry.DEFAULT_HEADERS : []),
            ...companyHeaders,
            ...svrHeaders,
        ];
        HeaderRegistry.instance = new HeaderRegistry(all);
    }

    /** The configured registry. Throws if configure() has not been called. */
    static get(): HeaderRegistry {
        if (!HeaderRegistry.instance) {
            throw new Error(
                'HeaderRegistry.configure(...) has not been called. Configure the registry ' +
                'at startup (before LogManager.setFactory) so filters/logging know the context keys.',
            );
        }
        return HeaderRegistry.instance;
    }

    /** True once configure() has run. Used by LogManager.setFactory to fail fast. */
    static isConfigured(): boolean {
        return HeaderRegistry.instance !== undefined;
    }

    /** All registered keys (deduplicated). */
    getKeys(): ContextKey[] {
        return this.keys;
    }

    /**
     * Keys that transfer over the wire (inbound request -> context, and context ->
     * outbound request): those with an httpHeader set.
     */
    getTransferredKeys(): ContextKey[] {
        return this.keys.filter((k: ContextKey) => k.httpHeader !== undefined);
    }

    /** Names (log keys) whose values must be masked in logs. isSecured=true. */
    getSecuredNames(): string[] {
        return this.keys
            .filter((k: ContextKey) => k.isSecured)
            .map((k: ContextKey) => k.name);
    }

    /** Keys that appear in logs. isLogged=true. */
    getLoggedKeys(): ContextKey[] {
        return this.keys.filter((k: ContextKey) => k.isLogged);
    }

    /** Look up a key by its HTTP header name (case-insensitive). */
    findByHttpHeader(httpHeader: string): ContextKey | undefined {
        const lower = httpHeader.toLowerCase();
        return this.keys.find((k: ContextKey) => k.httpHeader?.toLowerCase() === lower);
    }

    /**
     * Collapse exact duplicates, throw on conflicting definitions sharing a `name`
     * or an `httpHeader`.
     */
    private checkForDuplicates(allKeys: ContextKey[]): ContextKey[] {
        const byName = new Map<string, ContextKey>();
        const byHttpHeader = new Map<string, ContextKey>();

        for (const key of allKeys) {
            const nameKey = key.name.toLowerCase();
            const existing = byName.get(nameKey);
            if (existing) {
                this.assertSameDefinition(existing, key);
                continue; // exact duplicate - collapse
            }
            byName.set(nameKey, key);

            if (key.httpHeader !== undefined) {
                const headerKey = key.httpHeader.toLowerCase();
                const clash = byHttpHeader.get(headerKey);
                if (clash) {
                    throw new Error(
                        `Duplicate ContextKey httpHeader '${key.httpHeader}': ` +
                        `defined by key '${clash.name}' AND key '${key.name}'. ` +
                        `Each HTTP header must map to exactly one context key.`,
                    );
                }
                byHttpHeader.set(headerKey, key);
            }
        }

        return Array.from(byName.values());
    }

    /**
     * Two keys sharing a `name` must agree on httpHeader/isSecured/isLogged,
     * otherwise the platform would behave differently depending on which module's
     * definition happened to load first.
     */
    private assertSameDefinition(existing: ContextKey, duplicate: ContextKey): void {
        const conflicts: string[] = [];
        if (existing.httpHeader !== duplicate.httpHeader) {
            conflicts.push(`httpHeader ('${existing.httpHeader}' vs '${duplicate.httpHeader}')`);
        }
        if (existing.isSecured !== duplicate.isSecured) {
            conflicts.push(`isSecured (${existing.isSecured} vs ${duplicate.isSecured})`);
        }
        if (existing.isLogged !== duplicate.isLogged) {
            conflicts.push(`isLogged (${existing.isLogged} vs ${duplicate.isLogged})`);
        }
        if (conflicts.length > 0) {
            throw new Error(
                `Conflicting ContextKey definitions for '${existing.name}': ` +
                `two modules registered it with different ${conflicts.join(', ')}. ` +
                `Keys sharing a name must agree on all flags.`,
            );
        }
    }
}
