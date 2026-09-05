/**
 * HttpResponseDto - the ENTIRE HTTP response, as pure data, in the ONE form webpieces speaks.
 *
 * Modelled on java webpieces' `http/http1_1-parser/.../api/dto/` (`HttpPayload` -> `HttpMessage` ->
 * `HttpResponse` -> `HttpResponseStatusLine` -> `HttpResponseStatus`), flattened to the KISS subset
 * this framework actually needs.
 *
 * # Why a DTO at all, instead of handing an app express's `res` or fetch's `Response`
 *
 * Node/express and browser fetch model a response completely differently, and an
 * {@link ErrorTranslators} implementation is registered ONCE and serves BOTH — the server writing a
 * response and every client in the process reading one. So neither transport's object can be the
 * currency. webpieces normalises both into this DTO at its own boundary, and the app only ever sees
 * this. One form, both transports, both directions.
 *
 * # The two properties copied from java deliberately
 *
 * - **Headers are a LIST of `{name, value}`, not a Map.** HTTP permits repeats (`Set-Cookie` is the
 *   everyday one) and a Map silently drops all but the last. The REQUEST side of webpieces-ts
 *   already respects this (`readExpressHeaders` returns `Map<string, string[]>`), so the response
 *   side must not be the half that loses data.
 * - **Status is `{ code, reason }`, not a bare number.** The reason phrase is part of the response
 *   and an app may want its own ('Order Not Found' beside a 460).
 *
 * `HttpVersion` from the java DTO is deliberately OMITTED: express and fetch each own the version,
 * and no app decision depends on it.
 *
 * Pure data, so these are CLASSES with explicit constructors (webpieces guideline: data => classes),
 * and they live in core-util so the identical types reach a node server and a browser bundle.
 */
export class HttpHeader {
    constructor(
        public readonly name: string,
        public readonly value: string,
    ) {}
}

/** The status line's status: the numeric code AND the reason phrase that goes beside it. */
export class HttpResponseStatus {
    constructor(
        public readonly code: number,
        public readonly reason: string,
    ) {}
}

/**
 * The whole response: status (code + reason), the header LIST, and the body.
 *
 * `body` is `unknown` because it is whatever the app chose to publish. webpieces' OWN default puts a
 * {@link ProtocolError} there, and the built-in client mapping reads it back as one — but an app that
 * owns the whole response owns the body shape too, so the framework does not constrain it.
 */
export class HttpResponseDto {
    constructor(
        public readonly status: HttpResponseStatus,
        public readonly headers: readonly HttpHeader[],
        // webpieces-disable no-any-unknown -- the app owns the body shape when it owns the response; webpieces' own default puts a ProtocolError here, an app puts whatever it publishes
        public readonly body: unknown,
    ) {}
}
