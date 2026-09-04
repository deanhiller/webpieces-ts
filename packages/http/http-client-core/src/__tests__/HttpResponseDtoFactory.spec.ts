import { describe, it, expect } from 'vitest';
import { HttpHeader, HttpResponseDto, ProtocolError } from '@webpieces/core-util';
import { HttpResponseDtoFactory } from '../HttpResponseDtoFactory';

const factory = new HttpResponseDtoFactory();

const names = (dto: HttpResponseDto): string[] => dto.headers.map((h: HttpHeader) => h.name.toLowerCase());
const valuesOf = (dto: HttpResponseDto, name: string): string[] =>
    dto.headers.filter((h: HttpHeader) => h.name.toLowerCase() === name).map((h: HttpHeader) => h.value);

/**
 * The CLIENT-side transport boundary. Everything an app's `ErrorTranslators.fromWire` ever sees is
 * built here, in BOTH environments: `http-client-node` and `http-client-browser` share `ProxyClient`,
 * and `ProxyClient` is this class's only production caller. That is why "a node client and a browser
 * client hand fromWire the identical shape" is a structural property rather than a coincidence — and
 * why these specs are the whole pin for it.
 */
describe('HttpResponseDtoFactory normalises a fetch Response', () => {
    it('carries the status code AND the reason phrase, so an app status keeps its own phrase', () => {
        const dto = factory.fromFetch(new Response('{}', { status: 460, statusText: 'Order Not Found' }), {});

        expect(dto.status.code).toBe(460);
        expect(dto.status.reason).toBe('Order Not Found');
    });

    it('leaves an absent reason phrase EMPTY rather than inventing one (HTTP/2 sends none)', () => {
        const dto = factory.fromFetch(new Response('{}', { status: 503, statusText: '' }), {});

        expect(dto.status.reason).toBe('');
    });

    it('hands through the already-parsed body untouched, whatever its shape', () => {
        const body = new ProtocolError();
        body.errorCode = 'ORDER_NOT_FOUND';

        expect(factory.fromFetch(new Response(null, { status: 460 }), body).body).toBe(body);
    });

    it('keeps each Set-Cookie as its OWN entry — the reason headers are a list, not a Map', () => {
        const headers = new Headers();
        headers.append('set-cookie', 'a=1; Path=/');
        headers.append('set-cookie', 'b=2; Path=/');
        headers.append('retry-after', '600');

        const dto = factory.fromFetch(new Response(null, { status: 429, headers }), {});

        expect(valuesOf(dto, 'set-cookie')).toEqual(['a=1; Path=/', 'b=2; Path=/']);
        expect(valuesOf(dto, 'retry-after')).toEqual(['600']);
        // Exactly once each — the iteration pass must not double-count what getSetCookie() returns.
        expect(names(dto).filter((n: string) => n === 'set-cookie')).toHaveLength(2);
    });

    it('never throws on a runtime without getSetCookie() — it just reports no cookies', () => {
        const response = new Response(null, { status: 500, headers: { 'x-a': '1' } });
        // webpieces-disable no-any-unknown -- simulating an older lib.dom/node Headers, which has none
        // webpieces-disable no-inline-types -- a one-off structural cast onto a DOM type, in a spec
        (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie = undefined;

        expect(names(factory.fromFetch(response, {}))).toEqual(['x-a']);
    });
});
