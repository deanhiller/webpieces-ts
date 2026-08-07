import { describe, it, expect, beforeEach } from 'vitest';
import {
    AnyContextKey,
    AuthMode,
    ContextKey,
    ContextReader,
    DestinationTrust,
    HeaderRegistry,
    ServiceInfo,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-util';
import { MutableContextStore } from '../MutableContextStore';

const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');
const AUTH = ContextKey.untrusted<string>('authorization', 'authorization', /*maskInLogs*/ true);
const LOCAL_ONLY = ContextKey.untrusted<string>('localOnly'); // no httpHeader -> never transferred

/**
 * Every destination a browser can reach is one of these two — BrowserProxyClient refuses to bind an
 * @AuthOidc / @AuthSharedSecret contract at all, because it can neither mint a token nor hold a
 * secret. Both are the un-verifying kind, so a browser never sends a trusted key.
 */
const PUBLIC: AuthMode = { kind: 'public' };
const JWT: AuthMode = { kind: 'jwt', requirement: { allRolesAllowed: true } };
const TO_PUBLIC = DestinationTrust.forAuthMode(PUBLIC);

/** Configure the global registry with the platform defaults + these test keys, and reset identity. */
function configureRegistry(): void {
    HeaderRegistry.configure([TENANT, AUTH, LOCAL_ONLY], /*platformHeaders*/ true);
    ServiceInfo.clear();
}

describe('ContextMgr.buildOutboundHeaders', () => {
    beforeEach(configureRegistry);

    it('sends transferred keys with values, skips empty and non-transferred', () => {
        const store = new MutableContextStore();
        store.set(TENANT, 'tenant-42');
        store.set(LOCAL_ONLY, 'should-not-transfer');

        const contextMgr = new ContextMgr(store);
        const outbound = contextMgr.buildOutboundHeaders(TO_PUBLIC);

        expect(outbound.get('x-tenant-id')).toBe('tenant-42');
        expect(outbound.has('x-local-only')).toBe(false);   // no httpHeader -> not transferred
        expect(outbound.has('authorization')).toBe(false);  // no value in context
    });

    it('sends x-request-id as-is', () => {
        const store = new MutableContextStore();
        store.set(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

        const contextMgr = new ContextMgr(store);
        const outbound = contextMgr.buildOutboundHeaders(TO_PUBLIC);

        // The app's id goes out unchanged; the server's inbound transfer adopts it, and every hop
        // after that copies it onward. One id correlates the whole call tree.
        expect(outbound.get('x-request-id')).toBe('req-abc');
    });

    it('stamps the browser build version as x-webpieces-client-version when ServiceInfo is set', () => {
        ServiceInfo.setInfo('browser-app', 'b-2.0.0');
        const outbound = new ContextMgr(new MutableContextStore()).buildOutboundHeaders(TO_PUBLIC);

        // So a downstream server can log which client build called it (jsonPayload.clientVersion).
        expect(outbound.get('x-webpieces-client-version')).toBe('b-2.0.0');
    });

    it('omits x-webpieces-client-version when the app never identified itself', () => {
        // ServiceInfo.clear() ran in beforeEach → getVersion() is undefined → header absent.
        const outbound = new ContextMgr(new MutableContextStore()).buildOutboundHeaders(TO_PUBLIC);
        expect(outbound.has('x-webpieces-client-version')).toBe(false);
    });
});

/**
 * A browser must never put a trusted context key on the wire, and there are two independent reasons
 * it cannot — one of which is NOT load-bearing, which is why the destination check is applied here
 * rather than argued away:
 *
 *  1. `MutableContextStore.set` only accepts an untrusted key, so THAT store cannot hold one. But
 *     {@link ContextMgr} takes any app-supplied {@link ContextReader}, and `read` is handed an
 *     `AnyContextKey` — so this guarantee belongs to one implementation, not to the seam.
 *  2. `BrowserProxyClient.assertEndpointSupported` refuses to bind an @AuthOidc/@AuthSharedSecret
 *     contract, so every browser destination is @Public or @AuthJwt — the un-verifying kind.
 *
 * The rogue reader below is reason 1 defeated; the assertions are reason 2 holding anyway.
 */
class RogueTrustedReader implements ContextReader {
    read(key: AnyContextKey): string | undefined {
        return key.isTrusted() ? 'forged-user' : undefined;
    }
}

describe('a browser never sends a TRUSTED key', () => {
    beforeEach(configureRegistry);

    it('drops a trusted value even when the app-supplied ContextReader hands one over', () => {
        const contextMgr = new ContextMgr(new RogueTrustedReader());

        for (const mode of [PUBLIC, JWT]) {
            const outbound = contextMgr.buildOutboundHeaders(DestinationTrust.forAuthMode(mode));

            expect(outbound.has('x-user-id')).toBe(false);
            expect(outbound.has('x-org-id')).toBe(false);
            expect(outbound.has('x-webpieces-roles')).toBe(false);
        }
    });
});

describe('MutableContextStore', () => {
    it('set/read/remove/clear lifecycle', () => {
        const store = new MutableContextStore();
        store.set(TENANT, 't1');
        expect(store.read(TENANT)).toBe('t1');

        store.remove(TENANT);
        expect(store.read(TENANT)).toBeUndefined();

        store.set(TENANT, 't2');
        store.set(AUTH, 'tok');
        store.clear();
        expect(store.read(TENANT)).toBeUndefined();
        expect(store.read(AUTH)).toBeUndefined();
    });
});
