import {
    AuthMode,
    ContextKey,
    DestinationTrust,
    HeaderRegistry,
    ServiceInfo,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';
import { RequestContextHeaders } from '../RequestContextHeaders';

/**
 * The OUTBOUND half of the trust model (the inbound half lives in `ContextTrust.spec.ts`).
 *
 * The server admits an inbound `x-user-id` only on a route that authenticated its CALLER. So a client
 * that ships one to a `@Public` or `@AuthJwt` endpoint is building a request the callee is obliged to
 * 401 — and before {@link DestinationTrust} that is exactly what every internal service did, because
 * `buildOutboundHeaders` forwarded every transferred key with no idea what it was calling.
 *
 * These tests pin both directions of that rule, and the invariant that holds across both: an
 * UNTRUSTED key is never affected — nothing was ever going to make a security decision on it.
 */
const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`, stamped by AuthFilter', 'x-user-id');
const ORG_ID = ContextKey.trusted<string>('orgId', 'jwt claim `org`, stamped by AuthFilter', 'x-org-id');
const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

const headers = new RequestContextHeaders();

// AuthMode is a discriminated union, and these literals are its one spelling — the same one
// `defineAuthMode({ kind: 'public' })` uses in decorators.ts.
const PUBLIC: AuthMode = { kind: 'public' };
const JWT: AuthMode = { kind: 'jwt', requirement: { allRolesAllowed: true } };
const OIDC: AuthMode = { kind: 'oidc', callers: ['self'] };
const SHARED_SECRET: AuthMode = { kind: 'shared-secret', secretKey: 'peer-key' };

beforeEach(() => {
    HeaderRegistry.configure([USER_ID, ORG_ID, TENANT], /*platformHeaders*/ true);
    ServiceInfo.clear();
});

/** Stamp a trusted identity + an untrusted tag, then build the headers for `mode`'s destination. */
function outboundTo(mode: AuthMode | undefined): Map<string, string> {
    let built = new Map<string, string>();
    RequestContext.run(() => {
        RequestContext.putTrusted(USER_ID, 'user-7');
        RequestContext.putTrusted(ORG_ID, 'org-3');
        RequestContext.putUntrusted(TENANT, 'tenant-9');
        RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, 'req-1');
        built = headers.buildOutboundHeaders(DestinationTrust.forAuthMode(mode));
    });
    return built;
}

describe('buildOutboundHeaders gates TRUSTED keys on the destination', () => {
    it('OMITS them for a @Public destination — it could not tell us from curl', () => {
        const outbound = outboundTo(PUBLIC);

        expect(outbound.has('x-user-id')).toBe(false);
        expect(outbound.has('x-org-id')).toBe(false);
    });

    it('OMITS them for an @AuthJwt destination — it authenticates the USER, not the caller', () => {
        const outbound = outboundTo(JWT);

        expect(outbound.has('x-user-id')).toBe(false);
        expect(outbound.has('x-org-id')).toBe(false);
    });

    it('OMITS them when the endpoint declared NO mode — an absent declaration is never the widest', () => {
        const outbound = outboundTo(undefined);

        expect(outbound.has('x-user-id')).toBe(false);
    });

    it('SENDS them to an @AuthOidc destination — this is the propagation trusted keys exist for', () => {
        const outbound = outboundTo(OIDC);

        expect(outbound.get('x-user-id')).toBe('user-7');
        expect(outbound.get('x-org-id')).toBe('org-3');
    });

    it('SENDS them to an @AuthSharedSecret destination — the callee verifies us there too', () => {
        const outbound = outboundTo(SHARED_SECRET);

        expect(outbound.get('x-user-id')).toBe('user-7');
    });

    it('UNTRUSTED keys travel to every destination — the gate is about trust, not about secrecy', () => {
        for (const mode of [PUBLIC, JWT, OIDC, SHARED_SECRET, undefined]) {
            const outbound = outboundTo(mode);
            expect(outbound.get('x-tenant-id')).toBe('tenant-9');
            // The framework's own untrusted keys keep flowing too — the trace must not break.
            expect(outbound.has('x-request-id')).toBe(true);
        }
    });
});
