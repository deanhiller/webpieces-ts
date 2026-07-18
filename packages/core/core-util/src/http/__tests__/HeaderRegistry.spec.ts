import { describe, it, expect } from 'vitest';
import { ContextKey } from '../../ContextKey';
import { HeaderRegistry } from '../HeaderRegistry';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';

/**
 * Configure the GLOBAL registry from a flat set of keys (no platform defaults) and return it.
 * Each test fully re-configures, so the global singleton is deterministic per test.
 */
function configureWith(...keys: ContextKey[]): HeaderRegistry {
    HeaderRegistry.configure(keys, /*platformHeaders*/ false);
    return HeaderRegistry.get();
}

describe('HeaderRegistry.configure + queries', () => {
    it('get() throws before configure() is ever called', () => {
        // This runs first, before any configureWith(), so the global is unset.
        if (!HeaderRegistry.isConfigured()) {
            expect(() => HeaderRegistry.get()).toThrow(/configure/);
        }
    });

    it('configure() merges platform defaults + the provided keys', () => {
        HeaderRegistry.configure(
            [new ContextKey('clientType', 'x-client-type'), new ContextKey('tenantId', 'x-tenant-id')],
            /*platformHeaders*/ true,
        );
        const names = HeaderRegistry.get().getKeys().map(k => k.name);
        expect(names).toContain('requestId');   // from DEFAULT_HEADERS
        expect(names).toContain('tenantId');    // provided
        expect(names).toContain('clientType');  // provided
        expect(HeaderRegistry.isConfigured()).toBe(true);
    });

    it('collapses exact duplicates; findByHttpHeader is case-insensitive', () => {
        const tenant = new ContextKey('tenantId', 'x-tenant-id');
        const dupe = new ContextKey('tenantId', 'x-tenant-id');
        const registry = configureWith(tenant, dupe);

        expect(registry.getKeys()).toHaveLength(1);
        expect(registry.findByHttpHeader('X-Tenant-Id')).toBe(tenant);
    });

    it('getTransferredKeys filters to keys with an httpHeader', () => {
        const wire = new ContextKey('a', 'x-a');
        const local = new ContextKey('b'); // no httpHeader -> context-only
        const registry = configureWith(wire, local);

        expect(registry.getTransferredKeys()).toEqual([wire]);
    });

    it('getSecuredNames and getLoggedKeys expose the right subsets', () => {
        const auth = new ContextKey('authorization', 'authorization', /*isSecured*/ true);
        const reqId = new ContextKey('requestId', 'x-request-id');
        const hidden = new ContextKey('meta', undefined, false, /*isLogged*/ false);
        const registry = configureWith(auth, reqId, hidden);

        expect(registry.getSecuredNames()).toEqual(['authorization']);
        expect(registry.getLoggedKeys()).toEqual([auth, reqId]); // hidden excluded
    });
});

describe('HeaderRegistry dedup validation', () => {
    it('throws when two keys with the same name disagree on isSecured', () => {
        const open = new ContextKey('apiKey', 'x-api-key', false);
        const secured = new ContextKey('apiKey', 'x-api-key', true);

        expect(() => configureWith(open, secured)).toThrow(/Conflicting ContextKey definitions for 'apiKey'.*isSecured/);
    });

    it('throws when two keys with the same name disagree on httpHeader', () => {
        const a = new ContextKey('flag', 'x-flag-a');
        const b = new ContextKey('flag', 'x-flag-b');

        expect(() => configureWith(a, b)).toThrow(/httpHeader/);
    });

    it('throws when two keys with the same name disagree on isLogged', () => {
        const logged = new ContextKey('meta', undefined, false, true);
        const notLogged = new ContextKey('meta', undefined, false, false);

        expect(() => configureWith(logged, notLogged)).toThrow(/isLogged/);
    });

    it('throws when two DIFFERENT keys claim the same httpHeader', () => {
        const first = new ContextKey('requestId', 'x-request-id');
        const second = new ContextKey('reqIdAlt', 'x-request-id');

        expect(() => configureWith(first, second)).toThrow(/Duplicate ContextKey httpHeader 'x-request-id'/);
    });
});

describe('WebpiecesCoreHeaders.API_CALL_INFO', () => {
    it('is logged but NOT transferred over the wire (per-hop only)', () => {
        const key = WebpiecesCoreHeaders.API_CALL_INFO;
        expect(key.name).toBe('api');
        expect(key.isLogged).toBe(true);
        expect(key.isTransferred()).toBe(false); // httpHeader undefined -> never propagates to a downstream hop

        const registry = configureWith(...WebpiecesCoreHeaders.getAllHeaders());
        expect(registry.getTransferredKeys()).not.toContain(key);
        expect(registry.getLoggedKeys()).toContain(key);
    });
});
