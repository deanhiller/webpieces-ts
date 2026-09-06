import { HttpHeader, HttpResponseDto, HttpResponseStatus } from '@webpieces/core-util';

/**
 * fetch `Headers` as it exists on runtimes that expose repeated `Set-Cookie` values. `getSetCookie`
 * is OPTIONAL because older browsers and older node do not have it at all — its absence is a fact
 * about the runtime, not an error.
 */
interface SetCookieAwareHeaders {
    getSetCookie?: () => string[];
}

/**
 * HttpResponseDtoFactory - webpieces' CLIENT-side boundary between a transport and the one response
 * form an app is allowed to see.
 *
 * A fetch `Response` and an express `res` model a response completely differently, and an app's
 * `ErrorTranslators` is written ONCE and serves both. So neither is handed to the app: the server
 * writes an {@link HttpResponseDto} out (`ExpressWrapper`), and this reads one in. One form, both
 * transports, both directions — which is what makes `fromWire` receive the identical shape whether
 * the caller was `http-client-node` or `http-client-browser` (both share `ProxyClient`, and this is
 * the only place either builds a DTO).
 *
 * Stateless; one instance per client is fine.
 */
export class HttpResponseDtoFactory {
    /**
     * fetch `Response` + the already-parsed body -> the DTO.
     *
     * Headers come out as a LIST, and `getSetCookie()` is consulted where the runtime has it: fetch's
     * `Headers` JOINS repeated headers into one comma-separated string for every name EXCEPT
     * `set-cookie`, which it hides from iteration entirely. A Map-shaped response type would have
     * lost them either way; the list keeps each cookie its own entry, which is the whole reason
     * {@link HttpResponseDto.headers} is a list.
     *
     * `statusText` is the reason phrase as the server sent it; an empty one (HTTP/2 does not carry
     * reason phrases at all) stays empty rather than being invented here.
     */
    // webpieces-disable no-any-unknown -- the already-parsed body is app-owned data, carried through verbatim (see HttpResponseDto.body)
    public fromFetch(response: Response, body: unknown): HttpResponseDto {
        const headers: HttpHeader[] = [];
        response.headers.forEach((value: string, name: string) => {
            if (name.toLowerCase() !== 'set-cookie') {
                headers.push(new HttpHeader(name, value));
            }
        });
        for (const cookie of this.setCookies(response)) {
            headers.push(new HttpHeader('set-cookie', cookie));
        }
        return new HttpResponseDto(
            new HttpResponseStatus(response.status, response.statusText),
            headers,
            body,
        );
    }

    /**
     * Every `Set-Cookie` as its own value, or none where the runtime predates `getSetCookie()`
     * (older browsers, older node). Absent is not an error — it only means this runtime never
     * exposed repeated cookies to script in the first place.
     */
    private setCookies(response: Response): string[] {
        // webpieces-disable no-any-unknown -- getSetCookie() is absent on older lib.dom/node Headers
        const headers = response.headers as unknown as SetCookieAwareHeaders;
        return headers.getSetCookie ? headers.getSetCookie() : [];
    }
}
