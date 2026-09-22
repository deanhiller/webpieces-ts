import { describe, it, expect } from 'vitest';
import { AnyContextKey, ContextKey } from '../../ContextKey';
import { HeaderRegistry } from '../HeaderRegistry';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';

/**
 * The RESPONSE half of the registry — the exact mirror of what `HeaderRegistry.spec.ts` asserts for
 * the request half.
 *
 * The one assertion that matters most is the FIRST: `x-request-id` is an ORDINARY registry entry
 * now. It used to be a hard-coded `res.setHeader` in `ExpressWrapper.stampTransactionId` that no
 * other key could join without editing that method, and a registry entry it can be read off is the
 * test that the generalisation is real rather than a second mechanism beside the hard-code.
 */
const CACHE_STATUS = ContextKey.untrusted<string[]>(
    'cacheStatus',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-wp-cache-status',
);

const BACKEND = ContextKey.untrusted<string>(
    'backend',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-wp-backend',
    /*responseMerge*/ 'last',
);

describe('HeaderRegistry response-side keys', () => {
    it('x-request-id is an ordinary registry entry, not a hard-code', () => {
        HeaderRegistry.configure([], /*platformHeaders*/ true);

        const found = HeaderRegistry.get().findByResponseHeader('X-Request-Id');
        expect(found).toBe(WebpiecesCoreHeaders.REQUEST_ID);
        expect(HeaderRegistry.get().getResponseTxfrKeys()).toContain(
            WebpiecesCoreHeaders.REQUEST_ID,
        );
    });

    it('a second response key joins by DECLARING responseHeader, with no framework edit', () => {
        HeaderRegistry.configure([CACHE_STATUS, BACKEND], /*platformHeaders*/ true);

        const names = HeaderRegistry.get()
            .getResponseTxfrKeys()
            .map((k: AnyContextKey) => k.name);
        expect(names).toEqual(expect.arrayContaining(['requestId', 'cacheStatus', 'backend']));
        expect(HeaderRegistry.get().findByResponseHeader('x-wp-cache-status')).toBe(CACHE_STATUS);
    });

    it('a key with no responseHeader is NOT a response key', () => {
        HeaderRegistry.configure([], /*platformHeaders*/ true);
        expect(HeaderRegistry.get().getResponseTxfrKeys()).not.toContain(
            WebpiecesCoreHeaders.ACTION_ID,
        );
        expect(HeaderRegistry.get().findByResponseHeader('x-webpieces-actionid')).toBeUndefined();
    });

    it('REJECTS two keys claiming one response header, at configure() time', () => {
        const other = ContextKey.untrusted<string>(
            'otherCacheStatus',
            undefined,
            false,
            true,
            'x-wp-cache-status',
        );
        expect(() => HeaderRegistry.configure([CACHE_STATUS, other], false)).toThrow(
            /Duplicate ContextKey responseHeader 'x-wp-cache-status'/,
        );
    });

    it('REJECTS two keys sharing a name that DISAGREE on responseHeader', () => {
        const twin = ContextKey.untrusted<string[]>(
            'cacheStatus',
            undefined,
            false,
            true,
            'x-wp-cache-state',
        );
        expect(() => HeaderRegistry.configure([CACHE_STATUS, twin], false)).toThrow(
            /responseHeader \('x-wp-cache-status' vs 'x-wp-cache-state'\)/,
        );
    });

    it('REJECTS two keys sharing a name that DISAGREE on responseMerge', () => {
        const twin = ContextKey.untrusted<string[]>(
            'cacheStatus',
            undefined,
            false,
            true,
            'x-wp-cache-status',
            'last',
        );
        expect(() => HeaderRegistry.configure([CACHE_STATUS, twin], false)).toThrow(
            /responseMerge \('collect' vs 'last'\)/,
        );
    });

    it('collapses an EXACT duplicate declaration, as the request half does', () => {
        HeaderRegistry.configure([CACHE_STATUS, CACHE_STATUS], false);
        expect(HeaderRegistry.get().getResponseTxfrKeys()).toHaveLength(1);
    });
});

describe('ContextKey.mergeResponseValue', () => {
    it("'collect' appends, so a fan-out keeps every value", () => {
        expect(CACHE_STATUS.mergeResponseValue(undefined, 'miss')).toEqual(['miss']);
        expect(CACHE_STATUS.mergeResponseValue(['miss'], 'hit')).toEqual(['miss', 'hit']);
        // A scalar already under a collecting key is folded in, never thrown away.
        expect(CACHE_STATUS.mergeResponseValue('miss', 'hit')).toEqual(['miss', 'hit']);
    });

    it("'last' overwrites", () => {
        expect(BACKEND.mergeResponseValue('a', 'b')).toBe('b');
        expect(BACKEND.mergeResponseValue(undefined, 'b')).toBe('b');
    });

    it("'first' keeps what is already there — which is why an echoed requestId is a no-op", () => {
        expect(WebpiecesCoreHeaders.REQUEST_ID.mergeResponseValue('mine', 'echoed')).toBe('mine');
        expect(WebpiecesCoreHeaders.REQUEST_ID.mergeResponseValue(undefined, 'adopted')).toBe(
            'adopted',
        );
    });
});
