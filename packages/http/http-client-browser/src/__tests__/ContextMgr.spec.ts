import { describe, it, expect, beforeEach } from 'vitest';
import {
    ContextKey,
    HeaderRegistry,
    ServiceInfo,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-util';
import { MutableContextStore } from '../MutableContextStore';

const TENANT = new ContextKey('tenantId', 'x-tenant-id');
const AUTH = new ContextKey('authorization', 'authorization', /*isSecured*/ true);
const LOCAL_ONLY = new ContextKey('localOnly'); // no httpHeader -> never transferred

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
        const outbound = contextMgr.buildOutboundHeaders();

        expect(outbound.get('x-tenant-id')).toBe('tenant-42');
        expect(outbound.has('x-local-only')).toBe(false);   // no httpHeader -> not transferred
        expect(outbound.has('authorization')).toBe(false);  // no value in context
    });

    it('sends x-request-id as-is', () => {
        const store = new MutableContextStore();
        store.set(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

        const contextMgr = new ContextMgr(store);
        const outbound = contextMgr.buildOutboundHeaders();

        // The app's id goes out unchanged; the server's inbound transfer adopts it, and every hop
        // after that copies it onward. One id correlates the whole call tree.
        expect(outbound.get('x-request-id')).toBe('req-abc');
    });

    it('stamps the browser build version as x-webpieces-client-version when ServiceInfo is set', () => {
        ServiceInfo.setInfo('browser-app', 'b-2.0.0');
        const outbound = new ContextMgr(new MutableContextStore()).buildOutboundHeaders();

        // So a downstream server can log which client build called it (jsonPayload.clientVersion).
        expect(outbound.get('x-webpieces-client-version')).toBe('b-2.0.0');
    });

    it('omits x-webpieces-client-version when the app never identified itself', () => {
        // ServiceInfo.clear() ran in beforeEach → getVersion() is undefined → header absent.
        const outbound = new ContextMgr(new MutableContextStore()).buildOutboundHeaders();
        expect(outbound.has('x-webpieces-client-version')).toBe(false);
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
