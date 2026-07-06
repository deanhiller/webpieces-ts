import {
    HeaderMethods,
    HeaderRegistry,
    PlatformHeader,
    PlatformHeadersExtension,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-context';
import { MutableContextStore } from '../MutableContextStore';

const TENANT = new PlatformHeader('x-tenant-id', true, false, true, 'tenantId');
const AUTH = new PlatformHeader('authorization', true, true);
const LOCAL_ONLY = new PlatformHeader('x-local-only', false);

function buildRegistry(): HeaderRegistry {
    const headers = [
        ...WebpiecesCoreHeaders.getAllHeaders(),
        TENANT,
        AUTH,
        LOCAL_ONLY,
    ];
    return new HeaderRegistry([new PlatformHeadersExtension(headers)]);
}

describe('ContextMgr.buildOutboundHeaders', () => {
    it('sends transferred headers with values, skips empty and non-transferred', () => {
        const store = new MutableContextStore();
        store.set(TENANT, 'tenant-42');
        store.set(LOCAL_ONLY, 'should-not-transfer');

        const contextMgr = new ContextMgr(store, buildRegistry());
        const outbound = contextMgr.buildOutboundHeaders();

        expect(outbound.get('x-tenant-id')).toBe('tenant-42');
        expect(outbound.has('x-local-only')).toBe(false);      // isWantTransferred=false
        expect(outbound.has('authorization')).toBe(false);     // no value in context
    });

    it('chains request ids: x-request-id becomes x-previous-request-id', () => {
        const store = new MutableContextStore();
        store.set(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

        const contextMgr = new ContextMgr(store, buildRegistry());
        const outbound = contextMgr.buildOutboundHeaders();

        expect(outbound.get('x-previous-request-id')).toBe('req-abc');
        expect(outbound.has('x-request-id')).toBe(false);
    });

    it('passes x-request-id through unchanged when chaining is opted out', () => {
        const store = new MutableContextStore();
        store.set(WebpiecesCoreHeaders.REQUEST_ID, 'req-abc');

        const contextMgr = new ContextMgr(store, buildRegistry(), false);
        const outbound = contextMgr.buildOutboundHeaders();

        expect(outbound.get('x-request-id')).toBe('req-abc');
        expect(outbound.has('x-previous-request-id')).toBe(false);
    });
});

describe('ContextMgr.buildHeadersForLogging', () => {
    it('masks secured values and keys by loggerMdcKey when set', () => {
        const store = new MutableContextStore();
        store.set(TENANT, 'tenant-42');
        store.set(AUTH, 'super-secret-token-value');

        const contextMgr = new ContextMgr(store, buildRegistry());
        const logMap = contextMgr.buildHeadersForLogging(new HeaderMethods());

        // TENANT has loggerMdcKey 'tenantId' -> keyed by MDC key, raw value
        expect(logMap.get('tenantId')).toBe('tenant-42');
        // AUTH is secured, no mdc key -> keyed by header name, masked value
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
