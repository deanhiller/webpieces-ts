import { Request, Response, NextFunction } from 'express';
import {
    HttpResponseDto,
    WEBPIECES_DEFAULT_ERROR_TRANSLATORS,
    WebpiecesCoreHeaders,
    ClientRegistry,
    HttpBadRequestError,
    toError,
} from '@webpieces/core-util';
import { RequestContext, HttpRequest, RawRequest, RequestContextHeaders } from '@webpieces/core-context';
/**
 * The cap on an inbound body, in bytes. Reading stops and the request is refused the moment a body
 * crosses it — the bytes already read are dropped, nothing further is buffered.
 *
 * There was NO limit at all before, which was a latent memory DoS on every route and an outright one
 * on a webhook route: `{ rawBody: true }` retains what it reads, and a webhook url is public by
 * construction, so the endpoint most likely to be flooded was also the one that held on to the flood.
 * 10 MiB is comfortably above any api DTO and well under Cloud Run's own 32 MiB request limit.
 *
 * Read this as FRAMEWORK-FIXED, because today an app has no knob for it. The only seam that accepts a
 * different number is the {@link ExpressWrapper} constructor parameter, and nothing production reaches
 * it: `WebpiecesMiddleware.createExpressWrapper` forwards no such argument, and neither
 * `ExpressWrapper` nor this constant is exported from this package's barrel (`src/index.ts`), so the
 * only caller that can vary the cap is a spec inside this package. An app that legitimately needs to
 * accept a larger body therefore cannot unblock itself and has to open an issue. Making it tunable is a
 * code change, not a config one — a follow-up has to thread a value through `createExpressWrapper` and
 * decide where an app declares it (per-route, most likely, since that is the granularity the need has).
 */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export class ExpressWrapper {
    constructor(
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        private clientMethod: (requestDto: unknown) => Promise<unknown>,
        private path: string,
        /** Owns the wire<->context transfer, both directions. Stateless framework singleton. */
        private headers: RequestContextHeaders,
        /**
         * True for an @Endpoint(..., { formPost: true }) route: parse the body as
         * application/x-www-form-urlencoded (flat) instead of JSON. Driven by the ANNOTATION, not
         * the request Content-Type header — the annotation is the single source of truth.
         */
        private formPost: boolean = false,
        /**
         * True for an @Endpoint(..., { rawBody: true }) route: RETAIN the verbatim bytes + the
         * absolute url on the published {@link HttpRequest}, so an @AuthWebhook hook can verify a
         * vendor signature over what the sender actually transmitted. Also switches the JSON parse
         * failure from "throw now" to "hold it for AuthFilter" — see {@link RawRequest.bodyParseError}.
         */
        private rawBody: boolean = false,
        /**
         * The inbound body cap for this route. See {@link MAX_BODY_BYTES}.
         *
         * No production caller passes this — `WebpiecesMiddleware.createExpressWrapper` builds every
         * wrapper without it, so every live route runs on the default. The parameter exists so the
         * refusal path can be tested against a small cap instead of a 10 MiB fixture, and the specs in
         * this package are its only callers; it is not an app-facing tuning point, since the class is
         * not exported from `src/index.ts`. If a route ever needs a different cap, thread it through
         * `createExpressWrapper` rather than reaching around the middleware to construct a wrapper.
         */
        private maxBodyBytes: number = MAX_BODY_BYTES,
    ) {
    }

    public async execute(req: Request, res: Response, next: NextFunction): Promise<void> {
        // MOVED: Wrap entire request in RequestContext.run()
        // This establishes AsyncLocalStorage context for the request
        await RequestContext.run(async () => {
            await this.executeTryCatch(req, res, next);
        });
    }

    public async executeTryCatch(req: Request, res: Response, next: NextFunction): Promise<void> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- ExpressWrapper catches errors to translate to HTTP responses
        try {
            await this.executeImpl(req, res, next);
        } catch (err: unknown) {
            const error = toError(err);
            // 5. Handle errors
            this.handleError(res, error);
        }
    }

    public async executeImpl(req: Request, res: Response, next: NextFunction): Promise<void> {
        // Error translators need request metadata even when parsing fails.
        // Transfer headers and mint the id only after parsing (the accepted known limitation).
        RequestContext.setRequest(this.toWebpiecesRequest(req));
        // 1. Parse the request body. The PARSER is chosen by the @Endpoint annotation (this.formPost),
        //    NOT the request Content-Type header — the annotation is the single source of truth.
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        let requestDto: unknown = {};
        let raw: RawRequest | undefined;
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            // Read BYTES, not text. Concatenating per-chunk toString() corrupted any multi-byte
            // character that straddled a chunk boundary — invisible on small bodies, and fatal for a
            // signature computed over the bytes.
            const bodyBytes = await this.readRequestBody(req);
            const bodyText = bodyBytes.toString('utf8');
            let parseError: Error | undefined;
            if (this.formPost) {
                // application/x-www-form-urlencoded → flat key→value. URLSearchParams is lenient
                // (never throws) — right for EXTERNAL webhooks (e.g. Twilio) that post form-encoded.
                requestDto = Object.fromEntries(new URLSearchParams(bodyText));
            } else {
                // JSON (default, SYMMETRIC with the client's JSON.stringify). A non-JSON body is a
                // CLIENT error → 400, not the raw 500 an unguarded JSON.parse would throw.
                // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- translate parse failure to a 400 HttpError
                try {
                    requestDto = bodyText ? JSON.parse(bodyText) : {};
                } catch (err: unknown) {
                    const error = toError(err);
                    // On a raw-body (webhook) route the failure is HELD, not thrown: AuthFilter must
                    // answer 401 to an unauthenticated caller rather than 400, because "your JSON was
                    // bad" tells that caller it got past auth. Everywhere else, fail now as before.
                    if (!this.rawBody) {
                        throw new HttpBadRequestError('Request body is not valid JSON', undefined, undefined, error);
                    }
                    parseError = error;
                }
            }
            if (this.rawBody) {
                raw = new RawRequest(this.absoluteUrl(req), bodyBytes, req.socket?.remoteAddress, parseError);
            }
        }

        // 2. Translate express's request into the transport-neutral HttpRequest webpieces speaks.
        const httpRequest = this.toWebpiecesRequest(req, raw);

        // 3. Publish the transport-neutral HttpRequest, then move its headers into the context and
        //    mint a request id if the caller sent none. BOTH happen above the api boundary, because
        //    http-routing requires an already-established, already-filled request scope — it never
        //    builds one for you. This is the "translation layer" every transport must provide.
        this.headers.fillFromRequest(httpRequest);

        // 4. Invoke the api CLIENT method — the SAME proxy tests use. Its filter chain + controller
        //    run here, reading the context filled above; the chain never touches express `req`.
        const result = await this.clientMethod(requestDto);

        // 5. Serialize the response DTO to JSON (SYMMETRIC with client's response.json())
        const responseJson = JSON.stringify(result);
        this.writeRequestId(res);
        res.status(200).setHeader('Content-Type', 'application/json').send(responseJson);
    }

    /**
     * Read HTTP headers from Express request.
     * Returns Map of header name (lowercase) -> array of values.
     *
     * HTTP spec allows multiple values for same header name.
     */
    /**
     * express Request -> webpieces {@link HttpRequest}. THE translation layer: below this line the
     * filter chain and controllers never see express, which is what lets the same chain run
     * in-process with no transport at all.
     */
    private toWebpiecesRequest(req: Request, raw?: RawRequest): HttpRequest {
        return new HttpRequest(req.method, this.path, this.readExpressHeaders(req), raw);
    }

    /**
     * The absolute url AS THE SENDER ADDRESSED IT — the string a vendor like Twilio signed.
     *
     * `x-forwarded-proto` / `x-forwarded-host` WIN when present, because behind a TLS-terminating
     * proxy (Cloud Run, any load balancer) express's own view is wrong in both halves: `req.protocol`
     * reads `http` and the Host header is the internal one, while the vendor signed the public
     * `https://...` url the customer configured. Reconstructing naively therefore fails 100% of the
     * time in production and works 100% of the time locally — the worst possible pairing, so this is
     * stated here and pinned by a test rather than left to each app.
     *
     * These headers are attacker-controllable when nothing strips them, and that is ACCEPTABLE here
     * precisely because of what the value is used for: a forged url produces a signature that does not
     * verify, i.e. a 401. It grants nothing. (It is used for verification only — never for a redirect.)
     */
    private absoluteUrl(req: Request): string {
        const forwardedProto = req.headers['x-forwarded-proto'];
        const forwardedHost = req.headers['x-forwarded-host'];
        // A proxy chain sends a comma-separated list; the FIRST entry is the original client's hop.
        const proto = this.firstForwarded(forwardedProto) ?? req.protocol;
        const host = this.firstForwarded(forwardedHost) ?? req.get('host') ?? '';
        return `${proto}://${host}${req.originalUrl ?? req.url ?? this.path}`;
    }

    private firstForwarded(value: string | string[] | undefined): string | undefined {
        const raw = Array.isArray(value) ? value[0] : value;
        const first = raw?.split(',')[0]?.trim();
        return first === undefined || first === '' ? undefined : first;
    }

    private readExpressHeaders(req: Request): Map<string, string[]> {
        const headers = new Map<string, string[]>();

        // Express stores headers in req.headers as Record<string, string | string[]>
        for (const [name, value] of Object.entries(req.headers)) {
            const lowerName = name.toLowerCase();

            if (typeof value === 'string') {
                headers.set(lowerName, [value]);
            } else if (Array.isArray(value)) {
                headers.set(lowerName, value);
            }
        }

        return headers;
    }

    /**
     * Read the raw request body as BYTES (we parse manually rather than mounting express.json()).
     *
     * Bytes, not a growing string: a per-chunk `toString()` splits any multi-byte character that
     * straddles a chunk boundary into two replacement characters, so the body a webhook hook verified
     * would not be the body the vendor signed.
     *
     * REFUSES a body over {@link maxBodyBytes} the moment it crosses the line — the chunks read so far
     * are dropped and the stream is destroyed, so an oversize body is never fully buffered. It answers
     * 400 rather than 401 even on a webhook route, unavoidably: there is no way to authenticate a
     * caller whose request we are refusing to finish reading, and that ordering is the point.
     */
    private async readRequestBody(req: Request): Promise<Buffer> {
        return new Promise((resolve: (body: Buffer) => void, reject: (err: Error) => void) => {
            let chunks: Buffer[] = [];
            let size = 0;
            // A socket emits Buffers; a stream someone put in string mode (or a test's Readable.from)
            // emits strings. Normalize to bytes ONCE, here, so everything downstream counts and
            // concatenates the same units.
            req.on('data', (data: Buffer | string) => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
                size += chunk.length;
                if (size > this.maxBodyBytes) {
                    chunks = [];
                    req.destroy();
                    reject(new HttpBadRequestError(
                        `Request body exceeds the ${this.maxBodyBytes} byte limit`,
                    ));
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            req.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    /** Translate to the app's entire response, falling back to the shared default. */
    // webpieces-disable no-any-unknown -- a thrown value is unknown until normalized
    public handleError(res: Response, error: unknown): void {
        if (res.headersSent) return;
        const err = toError(error);
        const wire = ClientRegistry.tryTranslateToWire(err) ?? WEBPIECES_DEFAULT_ERROR_TRANSLATORS.toWire(err);
        this.writeErrorResponse(res, wire);
    }
    private writeErrorResponse(res: Response, wire: HttpResponseDto): void {
        res.status(wire.status.code);
        res.statusMessage = wire.status.reason;
        res.setHeader('Content-Type', 'application/json');
        const grouped = new Map<string, string[]>();
        for (const header of wire.headers) {
            const name = header.name.toLowerCase();
            const values = grouped.get(name) ?? [];
            values.push(header.value);
            grouped.set(name, values);
        }
        for (const entry of grouped) {
            const values = entry[1];
            res.setHeader(entry[0], values.length === 1 ? values[0] : values);
        }
        this.writeRequestId(res);
        const contentType = grouped.get('content-type')?.[0] ?? 'application/json';
        const payload = typeof wire.body === 'string' && !/\bjson\b/i.test(contentType)
            ? wire.body : JSON.stringify(wire.body);
        res.send(payload);
    }
    /** Trace infrastructure applies even when an app replaces the error envelope. */
    private writeRequestId(res: Response): void {
        if (!RequestContext.isActive()) return;
        const id = RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID);
        if (id) res.setHeader(WebpiecesCoreHeaders.REQUEST_ID.httpHeader!, id);
    }
}
