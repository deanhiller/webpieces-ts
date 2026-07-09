import { describe, it, expect, beforeEach } from 'vitest';
import {
    ContextKey,
    HeaderRegistry,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-util';
import { MutableContextStore } from '../MutableContextStore';

const TENANT = new ContextKey('tenantId', 'x-tenant-id');
const AUTH = new ContextKey('authorization', 'authorization', /*isSecured*/ true);
const LOCAL_ONLY = new ContextKey('localOnly'); // no httpHeader -> never transferred

/** Configure the global registry with the platform defaults + these test keys. */
function configureRegistry(): void {
    HeaderRegistry.configure([TENANT, AUTH, LOCAL_ONLY], [], /*platformHeaders*/ true);
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
});

describe('HeaderRegistry.buildLogFields (browser store)', () => {
    beforeEach(configureRegistry);

    it('masks secured values and keys by name', () => {
        const store = new MutableContextStore();
        store.set(TENANT, 'tenant-42');
        store.set(AUTH, 'super-secret-token-value');

        // The registry owns the keys; the caller only says WHERE to read. ContextMgr no longer
        // has a buildHeadersForLogging(): a logging BACKEND stamps context fields, not the client.
        const logMap = HeaderRegistry.get().buildLogFields((key: ContextKey) => store.read(key));

        // TENANT -> keyed by its name, raw value
        expect(logMap.get('tenantId')).toBe('tenant-42');
        // AUTH is secured -> keyed by name, masked value
        const masked = logMap.get('authorization');
        expect(masked).toBeDefined();
        expect(masked).not.toContain('secret');
        expect(masked).toMatch(/\.\.\./);
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
