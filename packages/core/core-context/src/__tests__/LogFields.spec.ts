import { describe, it, expect, afterEach } from 'vitest';
import { ContextKey, HeaderRegistry, ServiceInfo, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from '../RequestContext';

/**
 * RequestContext.buildLogFields / buildStructuredLogFields — the log-field maps the node logging
 * backends read on every line. This logic used to live on HeaderRegistry behind a read callback, but
 * only the server ever called it, so it was inlined here. These tests pin the behavior that moved:
 * object survival, secured masking, the empty-map-outside-run guard, AND the ServiceInfo `version`
 * that buildStructuredLogFields adds so every request line says which build emitted it.
 */
describe('RequestContext log-field builders', () => {
    const api = new ContextKey('api', undefined, /*isSecured*/ false, /*isLogged*/ true); // object-valued
    const reqId = new ContextKey('requestId', 'x-request-id');
    const secret = new ContextKey('authorization', 'authorization', /*isSecured*/ true);

    afterEach(() => {
        ServiceInfo.clear();
    });

    it('structured builder keeps an OBJECT value; flat builder DROPS it', () => {
        HeaderRegistry.configure([api, reqId], /*platformHeaders*/ false);
        const apiValue = { side: 'client', type: 'request' };

        RequestContext.run(() => {
            RequestContext.putHeader(api, apiValue);
            RequestContext.putHeader(reqId, 'abc');

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
            RequestContext.putHeader(secret, 'abcdefghijklmnop'); // len>15 → abc...nop
            expect(RequestContext.buildStructuredLogFields().get('authorization')).toBe('abc...nop');
            expect(RequestContext.buildLogFields().get('authorization')).toBe('abc...nop');
        });
    });

    it('structured builder stamps ServiceInfo `version` — present after setInfo, ABSENT before', () => {
        HeaderRegistry.configure([reqId], /*platformHeaders*/ false);

        RequestContext.run(() => {
            RequestContext.putHeader(reqId, 'abc');

            // Before setInfo: logging still works, version simply omitted.
            expect(RequestContext.buildStructuredLogFields().has('version')).toBe(false);

            ServiceInfo.setInfo('billing-svc', 'v3.2.1-rc4');
            expect(RequestContext.buildStructuredLogFields().get('version')).toBe('v3.2.1-rc4');
        });
    });

    it('returns an EMPTY map outside RequestContext.run — a log line never crashes a request', () => {
        HeaderRegistry.configure([reqId], /*platformHeaders*/ false);
        ServiceInfo.setInfo('billing-svc', 'v1');

        expect(RequestContext.buildLogFields().size).toBe(0);
        expect(RequestContext.buildStructuredLogFields().size).toBe(0); // even version is omitted with no active scope
    });

    it('clientVersion arriving inbound rides the flat + structured maps (isLogged transferred key)', () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.getAllHeaders(), /*platformHeaders*/ false);

        RequestContext.run(() => {
            RequestContext.putHeader(WebpiecesCoreHeaders.CLIENT_VERSION, 'caller-v9');
            expect(RequestContext.buildLogFields().get('clientVersion')).toBe('caller-v9');
        });
    });
});
