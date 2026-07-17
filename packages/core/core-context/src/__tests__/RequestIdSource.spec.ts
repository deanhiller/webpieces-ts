import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HeaderRegistry, ServiceInfo, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { HttpRequest } from '../HttpRequest';
import { RequestContext } from '../RequestContext';
import { RequestContextHeaders } from '../RequestContextHeaders';

const headers = new RequestContextHeaders();

beforeEach(() => {
    HeaderRegistry.configure([], /*platformHeaders*/ true);
    ServiceInfo.clear();
    ServiceInfo.setInfo('svc-a', '1.0.0');
});

afterEach(() => {
    ServiceInfo.clear();
});

/** Fill the context from an inbound request carrying `inboundHeaders`, and read back a key. */
function fillFrom(inboundHeaders: Map<string, string[]>, read: () => string | undefined): string | undefined {
    let result: string | undefined;
    RequestContext.run(() => {
        headers.fillFromRequest(new HttpRequest('POST', '/some/path', inboundHeaders));
        result = read();
    });
    return result;
}

const requestId = (): string | undefined => RequestContext.getHeader<string>(WebpiecesCoreHeaders.REQUEST_ID);
const source = (): string | undefined => RequestContext.getHeader<string>(WebpiecesCoreHeaders.REQUEST_ID_SOURCE);

/**
 * requestIdSource records WHICH service minted the request id — the one thing the id alone cannot
 * say. Its meaning rests entirely on being stamped ONLY where the id is generated, and on NOT
 * travelling over the wire; either half breaking makes it a lie.
 */
describe('REQUEST_ID_SOURCE records who MINTED the request id', () => {
    it('the ORIGIN stamps itself — no inbound x-request-id means we minted it', () => {
        const stamped = fillFrom(new Map(), source);

        expect(stamped).toBe('svc-a');
    });

    /**
     * The core of the semantics: a hop that INHERITED the id did not mint it, so it must leave the
     * key absent. Present == "I am the trace's origin". If this stamped unconditionally, every hop
     * would claim to be the origin and the field would mean nothing.
     */
    it('a hop that INHERITS an id leaves the source ABSENT — it is not the origin', () => {
        const inbound = new Map([['x-request-id', ['caller-generated-id']]]);

        const result = fillFrom(inbound, () => `${requestId()}|${source()}`);

        // The id propagates unchanged, and precisely because it did, we did NOT mint it.
        expect(result).toBe('caller-generated-id|undefined');
    });

    /**
     * Not transferred over the wire, and that is the whole point: if it travelled, hop 2 would
     * inherit hop 1's source and "who started this trace" would be indistinguishable from "who
     * passed it along".
     */
    it('is NOT transferred outbound — otherwise the next hop would inherit our origin claim', () => {
        RequestContext.run(() => {
            headers.fillFromRequest(new HttpRequest('POST', '/p', new Map()));

            const outbound = headers.buildOutboundHeaders();

            // The id itself DOES travel — one id correlates the whole call tree...
            expect(outbound.get('x-request-id')).toBeDefined();
            // ...but nothing carries the source onward. It has no wire name at all.
            expect(WebpiecesCoreHeaders.REQUEST_ID_SOURCE.httpHeader).toBeUndefined();
            expect([...outbound.values()]).not.toContain('svc-a');
        });
    });

    it('is a LOGGED key — it exists to show up on every line as requestIdSource', () => {
        expect(WebpiecesCoreHeaders.REQUEST_ID_SOURCE.isLogged).toBe(true);
        expect(WebpiecesCoreHeaders.REQUEST_ID_SOURCE.name).toBe('requestIdSource');
    });

    /**
     * fillFromRequest runs PER REQUEST. Throwing here over a missing log field would 500 every
     * request in production — far worse than the field being absent. Real servers cannot reach this
     * state (setupRuntime asserts the name at boot); only a test driving the context directly can.
     */
    it('an UNNAMED service still serves the request — it just omits the field, never throws', () => {
        ServiceInfo.clear();

        const result = fillFrom(new Map(), () => `${requestId() ? 'id-minted' : 'no-id'}|${source()}`);

        expect(result).toBe('id-minted|undefined');
    });
});
