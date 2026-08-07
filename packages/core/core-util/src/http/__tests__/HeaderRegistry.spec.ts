import { describe, it, expect } from 'vitest';
import { ContextKey, AnyContextKey } from '../../ContextKey';
import { HeaderRegistry } from '../HeaderRegistry';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';

/**
 * Configure the GLOBAL registry from a flat set of keys (no platform defaults) and return it.
 * Each test fully re-configures, so the global singleton is deterministic per test.
 */
function configureWith(...keys: AnyContextKey[]): HeaderRegistry {
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
            [ContextKey.untrusted<string>('clientType', 'x-client-type'), ContextKey.untrusted<string>('tenantId', 'x-tenant-id')],
            /*platformHeaders*/ true,
        );
        const names = HeaderRegistry.get().getKeys().map(k => k.name);
        expect(names).toContain('requestId');   // from DEFAULT_HEADERS
        expect(names).toContain('tenantId');    // provided
        expect(names).toContain('clientType');  // provided
        expect(HeaderRegistry.isConfigured()).toBe(true);
    });

    it('collapses exact duplicates; findByHttpHeader is case-insensitive', () => {
        const tenant = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');
        const dupe = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');
        const registry = configureWith(tenant, dupe);

        expect(registry.getKeys()).toHaveLength(1);
        expect(registry.findByHttpHeader('X-Tenant-Id')).toBe(tenant);
    });

    it('getTransferredKeys filters to keys with an httpHeader', () => {
        const wire = ContextKey.untrusted<string>('a', 'x-a');
        const local = ContextKey.untrusted<string>('b'); // no httpHeader -> context-only
        const registry = configureWith(wire, local);

        expect(registry.getTransferredKeys()).toEqual([wire]);
    });

    it('getMaskedNames and getLoggedKeys expose the right subsets', () => {
        const auth = ContextKey.untrusted<string>('authorization', 'authorization', /*maskInLogs*/ true);
        const reqId = ContextKey.untrusted<string>('requestId', 'x-request-id');
        const hidden = ContextKey.untrusted<string>('meta', undefined, false, /*isLogged*/ false);
        const registry = configureWith(auth, reqId, hidden);

        expect(registry.getMaskedNames()).toEqual(['authorization']);
        expect(registry.getLoggedKeys()).toEqual([auth, reqId]); // hidden excluded
    });
});

describe('HeaderRegistry dedup validation', () => {
    it('throws when two keys with the same name disagree on maskInLogs', () => {
        const open = ContextKey.untrusted<string>('apiKey', 'x-api-key', false);
        const secured = ContextKey.untrusted<string>('apiKey', 'x-api-key', true);

        expect(() => configureWith(open, secured)).toThrow(/Conflicting ContextKey definitions for 'apiKey'.*maskInLogs/);
    });

    it('throws when two keys with the same name disagree on httpHeader', () => {
        const a = ContextKey.untrusted<string>('flag', 'x-flag-a');
        const b = ContextKey.untrusted<string>('flag', 'x-flag-b');

        expect(() => configureWith(a, b)).toThrow(/httpHeader/);
    });

    it('throws when two keys with the same name disagree on isLogged', () => {
        const logged = ContextKey.untrusted<string>('meta', undefined, false, true);
        const notLogged = ContextKey.untrusted<string>('meta', undefined, false, false);

        expect(() => configureWith(logged, notLogged)).toThrow(/isLogged/);
    });

    it('throws when two DIFFERENT keys claim the same httpHeader', () => {
        const first = ContextKey.untrusted<string>('requestId', 'x-request-id');
        const second = ContextKey.untrusted<string>('reqIdAlt', 'x-request-id');

        expect(() => configureWith(first, second)).toThrow(/Duplicate ContextKey httpHeader 'x-request-id'/);
    });
});

describe('WebpiecesCoreHeaders.ACTION_ID', () => {
    it('is the app-minted grouping id: transferred over the wire AND logged', () => {
        const key = WebpiecesCoreHeaders.ACTION_ID;
        expect(key.name).toBe('actionId');
        expect(key.httpHeader).toBe('x-webpieces-actionid'); // rides every call of one user action
        expect(key.isTransferred()).toBe(true);              // follows the action across service hops
        expect(key.isLogged).toBe(true);

        const registry = configureWith(...WebpiecesCoreHeaders.ALL_HEADERS);
        expect(registry.getTransferredKeys()).toContain(key);
        expect(registry.getLoggedKeys()).toContain(key);
    });
});

describe('WebpiecesCoreHeaders.API_CALL_INFO', () => {
    it('is logged but NOT transferred over the wire (per-hop only)', () => {
        const key = WebpiecesCoreHeaders.API_CALL_INFO;
        expect(key.name).toBe('api');
        expect(key.isLogged).toBe(true);
        expect(key.isTransferred()).toBe(false); // httpHeader undefined -> never propagates to a downstream hop

        const registry = configureWith(...WebpiecesCoreHeaders.ALL_HEADERS);
        expect(registry.getTransferredKeys()).not.toContain(key);
        expect(registry.getLoggedKeys()).toContain(key);
    });

    it('throws when two keys with the same name disagree on TRUST', () => {
        // The most dangerous of the three disagreements: whichever module loaded first would decide
        // whether every reader of this key is authorizing on a spoofable value.
        const proven = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
        const asserted = ContextKey.untrusted<string>('userId', 'x-user-id');

        expect(() => configureWith(proven, asserted))
            .toThrow(/Conflicting ContextKey definitions for 'userId'.*trust \('trusted' vs 'untrusted'\)/);
    });
});
