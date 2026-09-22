import { describe, it, expect, beforeEach } from 'vitest';
import {
    AuthMode,
    ContextKey,
    DestinationTrust,
    HeaderRegistry,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';
import { RequestContextHeaders } from '../RequestContextHeaders';

/**
 * The RESPONSE direction of the magic context: `buildResponseHeaders` (context -> this hop's
 * response) and `acceptResponseHeaders` (a callee's response -> this hop's context). Together they
 * are what makes a value travel UP the call tree hop by hop, with nothing in between naming HTTP.
 */

/** A DIAGNOSTIC fan-out key: five services answering one request all have something to say. */
const CACHE_STATUS = ContextKey.untrusted<string[]>(
    'cacheStatus',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-wp-cache-status',
);

/** A single-valued key, so the merge policies are exercised against each other. */
const BACKEND = ContextKey.untrusted<string>(
    'backend',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-wp-backend',
    /*responseMerge*/ 'last',
);

/**
 * A TRUSTED response key — the whole reason `acceptResponseHeaders` takes a destination. A response
 * is another process's ASSERTION, so believing this one from a server that never authenticated to us
 * is exactly the hole the inbound `PendingWireTrust` machinery closes in the other direction.
 */
const TRUSTED_TIER = ContextKey.trusted<string>(
    'accountTier',
    'asserted by an internal peer we authenticated to, on its response',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-wp-account-tier',
    /*responseMerge*/ 'last',
);

const OIDC: AuthMode = { kind: 'oidc' };
const PUBLIC: AuthMode = { kind: 'public' };
/** An internal peer we authenticate to — its response assertions are believable. */
const FROM_PEER = DestinationTrust.forAuthMode(OIDC);
/** A partner / browser-reachable endpoint — its response assertions are not. */
const FROM_STRANGER = DestinationTrust.forAuthMode(PUBLIC);

class Harness {
    readonly headers = new RequestContextHeaders();

    /** One response carrying the given headers, as a client would hand it over. */
    response(entries: Array<[string, string]>): Headers {
        const headers = new Headers();
        for (const entry of entries) {
            headers.set(entry[0], entry[1]);
        }
        return headers;
    }
}

const harness = new Harness();

describe('buildResponseHeaders — context -> THIS hop response', () => {
    beforeEach(() => {
        HeaderRegistry.configure([CACHE_STATUS, BACKEND, TRUSTED_TIER], /*platformHeaders*/ true);
    });

    it('writes x-request-id on every response, with NO key named in the server code', () => {
        RequestContext.run(() => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'req-9');
            expect(harness.headers.buildResponseHeaders().get('x-request-id')).toBe('req-9');
        });
    });

    it('a SECOND response key reaches the response with no framework edit', () => {
        RequestContext.run(() => {
            RequestContext.putUntrusted(BACKEND, 'svc-b');
            expect(harness.headers.buildResponseHeaders().get('x-wp-backend')).toBe('svc-b');
        });
    });

    it("a 'collect' key goes out as the comma-separated list HTTP already has a grammar for", () => {
        RequestContext.run(() => {
            RequestContext.putUntrusted(CACHE_STATUS, ['miss', 'hit', 'miss']);
            expect(harness.headers.buildResponseHeaders().get('x-wp-cache-status')).toBe(
                'miss, hit, miss',
            );
        });
    });

    it('is EMPTY, not a throw, outside a request scope (the accepted parse-failure path)', () => {
        expect(harness.headers.buildResponseHeaders().size).toBe(0);
    });

    it('skips a key with no wire form rather than serializing an object', () => {
        RequestContext.run(() => {
            expect(harness.headers.buildResponseHeaders().has('x-wp-cache-status')).toBe(false);
        });
    });
});

describe('acceptResponseHeaders — a callee response -> the CALLER context', () => {
    beforeEach(() => {
        HeaderRegistry.configure([CACHE_STATUS, BACKEND, TRUSTED_TIER], /*platformHeaders*/ true);
    });

    it('an UNTRUSTED response key is readable from the caller context after the call', () => {
        RequestContext.run(() => {
            harness.headers.acceptResponseHeaders(
                harness.response([['x-wp-backend', 'svc-b']]),
                FROM_STRANGER,
            );
            expect(RequestContext.getUntrusted(BACKEND)).toBe('svc-b');
        });
    });

    it("'collect' ACCUMULATES across a fan-out of three calls", () => {
        RequestContext.run(() => {
            for (const status of ['miss', 'hit', 'miss']) {
                harness.headers.acceptResponseHeaders(
                    harness.response([['x-wp-cache-status', status]]),
                    FROM_STRANGER,
                );
            }
            // Five calls answering one request must not silently keep one value.
            expect(RequestContext.getUntrusted(CACHE_STATUS)).toEqual(['miss', 'hit', 'miss']);
        });
    });

    it('travels TWO hops: what hop 2 accepted, hop 1 then writes on its OWN response', () => {
        RequestContext.run(() => {
            // hop 2 answers us with its backend name...
            harness.headers.acceptResponseHeaders(
                harness.response([['x-wp-backend', 'svc-c']]),
                FROM_PEER,
            );
            // ...and it is on OUR response to hop 0 without this code naming a header.
            expect(harness.headers.buildResponseHeaders().get('x-wp-backend')).toBe('svc-c');
        });
    });

    it('DROPS a TRUSTED response key from a destination we did not authenticate to', () => {
        RequestContext.run(() => {
            harness.headers.acceptResponseHeaders(
                harness.response([['x-wp-account-tier', 'platinum']]),
                FROM_STRANGER,
            );
            // A partner's server asserting a trusted fact on its response is not believed.
            expect(RequestContext.getTrusted(TRUSTED_TIER)).toBeUndefined();
        });
    });

    it('ADMITS a TRUSTED response key from a destination we DID authenticate to', () => {
        RequestContext.run(() => {
            harness.headers.acceptResponseHeaders(
                harness.response([['x-wp-account-tier', 'platinum']]),
                FROM_PEER,
            );
            expect(RequestContext.getTrusted(TRUSTED_TIER)).toBe('platinum');
        });
    });

    it("keeps OUR requestId when a callee echoes it back ('first')", () => {
        RequestContext.run(() => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'mine');
            harness.headers.acceptResponseHeaders(
                harness.response([['x-request-id', 'mine']]),
                FROM_PEER,
            );
            expect(RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID)).toBe('mine');
        });
    });

    it('ignores a response header that is not a registered response key', () => {
        RequestContext.run(() => {
            harness.headers.acceptResponseHeaders(
                harness.response([['x-random-vendor-header', 'whatever']]),
                FROM_PEER,
            );
            expect(RequestContext.buildLogFields().has('x-random-vendor-header')).toBe(false);
        });
    });

    it('THROWS outside a request scope, exactly as the outbound builder does', () => {
        expect(() =>
            harness.headers.acceptResponseHeaders(harness.response([]), FROM_PEER),
        ).toThrow(/No active RequestContext/);
    });
});
