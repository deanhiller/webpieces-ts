import { describe, it, expect, afterEach } from 'vitest';
import { ContextKey, HeaderRegistry, ServiceInfo, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';

/**
 * RequestContext.buildLogFields / buildStructuredLogFields — the log-field maps the node logging
 * backends read on every line. This logic used to live on HeaderRegistry behind a read callback, but
 * only the server ever called it, so it was inlined here. These tests pin the behavior that moved:
 * object survival, secured masking, the empty-FLAT-map-outside-run guard, AND the ServiceInfo
 * `version` that buildStructuredLogFields adds — even OUT of context — so every line (request path,
 * startup, background job) says which build emitted it.
 */
describe('RequestContext log-field builders', () => {
    const api = ContextKey.untrusted<object>('api', undefined, /*maskInLogs*/ false, /*isLogged*/ true); // object-valued (an AnyContextKey)
    const reqId = ContextKey.untrusted<string>('requestId', 'x-request-id');
    const secret = ContextKey.untrusted<string>('authorization', 'authorization', /*maskInLogs*/ true);

    afterEach(() => {
        ServiceInfo.clear();
    });

    it('structured builder keeps an OBJECT value; flat builder DROPS it', () => {
        HeaderRegistry.configure([api, reqId], /*platformHeaders*/ false);
        const apiValue = { side: 'client', type: 'request' };

        RequestContext.run(() => {
            RequestContext.putUntrusted(api, apiValue);
            RequestContext.putUntrusted(reqId, 'abc');

            const structured = RequestContext.buildStructuredLogFields();
            expect(structured.get('api')).toEqual(apiValue); // object survives → nests into jsonPayload.api
            expect(structured.get('requestId')).toBe('abc');

            const flat = RequestContext.buildLogFields();
            expect(flat.has('api')).toBe(false); // object-valued key skipped from the string map
            expect(flat.get('requestId')).toBe('abc');
        });
    });

    it('both builders mask secured STRING values', () => {
        HeaderRegistry.configure([secret], /*platformHeaders*/ false);

        RequestContext.run(() => {
            RequestContext.putUntrusted(secret, 'abcdefghijklmnop'); // len>15 → abc...nop
            expect(RequestContext.buildStructuredLogFields().get('authorization')).toBe('abc...nop');
            expect(RequestContext.buildLogFields().get('authorization')).toBe('abc...nop');
        });
    });

    it('structured builder stamps ServiceInfo `version` — present after setInfo, ABSENT before', () => {
        HeaderRegistry.configure([reqId], /*platformHeaders*/ false);

        RequestContext.run(() => {
            RequestContext.putUntrusted(reqId, 'abc');

            // Before setInfo: logging still works, version simply omitted.
            expect(RequestContext.buildStructuredLogFields().has('version')).toBe(false);

            ServiceInfo.setInfo('billing-svc', 'v3.2.1-rc4');
            expect(RequestContext.buildStructuredLogFields().get('version')).toBe('v3.2.1-rc4');
        });
    });

    it('clientVersion arriving inbound rides the flat + structured maps (isLogged transferred key)', () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, /*platformHeaders*/ false);

        RequestContext.run(() => {
            RequestContext.putUntrusted(WebpiecesCoreHeaders.CLIENT_VERSION, 'caller-v9');
            expect(RequestContext.buildLogFields().get('clientVersion')).toBe('caller-v9');
        });
    });
});

// The structured builder stamps the ServiceInfo identity (`svcName` + `version`) even with NO active
// RequestContext, so startup and background-job lines say which service/build emitted them — the flat
// builder stays empty out of context. Both facts are treated identically (backend-symmetrical).
describe('buildStructuredLogFields — svcName + version outside RequestContext.run', () => {
    const reqId = ContextKey.untrusted<string>('requestId', 'x-request-id');

    afterEach(() => {
        ServiceInfo.clear();
    });

    it('carries `svcName` + `version` while buildLogFields stays EMPTY (log line never crashes a request)', () => {
        HeaderRegistry.configure([reqId], /*platformHeaders*/ false);
        ServiceInfo.setInfo('billing-svc', 'v1');

        expect(RequestContext.buildLogFields().size).toBe(0); // flat map: empty with no active scope
        const structured = RequestContext.buildStructuredLogFields();
        expect(structured.size).toBe(2);
        expect(structured.get('svcName')).toBe('billing-svc'); // process-global identity facts,
        expect(structured.get('version')).toBe('v1');          // not context keys
    });

    it('is empty before setInfo — svcName + version simply absent, logging still works', () => {
        HeaderRegistry.configure([reqId], /*platformHeaders*/ false);

        expect(RequestContext.buildStructuredLogFields().size).toBe(0);
    });
});
