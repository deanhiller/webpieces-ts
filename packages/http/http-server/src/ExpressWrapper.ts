import { Request, Response, NextFunction } from 'express';
import {
    ClientRegistry,
    ApiBadRequestError,
    HttpContractMapper,
    HttpResponseDto,
    HttpResponseStatus,
    RouteMetadata,
    ApiImplementationError,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import {
    RequestContext,
    HttpRequest,
    RawRequest,
    RequestContextHeaders,
} from '@webpieces/core-context';
import { ExpressResponseWriter } from './ExpressResponseWriter';
import { ApiErrorHttpMapper, EndUserStatus } from './ApiErrorHttpMapper';
import { RequestBodyReader } from './body/RequestBodyReader';
import { StreamBodyReader } from './body/StreamBodyReader';

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

/**
 * What {@link ExpressWrapper.parseBody} produced: the DTO the controller receives, the verbatim
 * {@link RawRequest} when the route asked for one, and the held parse failure on a raw-body route.
 *
 * Data-only, so a class rather than an inline object literal, per the webpieces guidelines.
 */
class ParsedBody {
    constructor(
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        public readonly requestDto: unknown,
        public readonly raw: RawRequest | undefined,
        /** Set only on a raw-body route, where the failure is HELD for AuthFilter instead of thrown. */
        public readonly parseError?: Error,
    ) {}
}

export class ExpressWrapper {
    /**
     * Decides what an outside caller is allowed to see of a thrown {@link API error}. Stateless —
     * one instance per wrapper is fine, and the class doc there is where the "only ApiEndUserError's
     * message goes on the wire" rule is stated.
     */
    private readonly errorWireMapper: ApiErrorHttpMapper;
    private readonly responseWriter = new ExpressResponseWriter();

    constructor(
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        private clientMethod: (...args: unknown[]) => Promise<unknown>,
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
         * absolute url on the published {@link HttpRequest}, so an @WpAuthWebhook hook can verify a
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
        /** Exact shared contract route; omitted only by focused legacy wrapper unit tests. */
        private readonly routeMeta?: RouteMetadata,
        /**
         * Where the body bytes come from. The default reads the request stream; a host that parses
         * the body before webpieces runs (Cloud Functions gen2) needs `PreConsumedBodyReader`,
         * chosen via `WebpiecesExpressRouter.setBodyReader`. See {@link RequestBodyReader}.
         */
        private readonly bodyReader: RequestBodyReader = new StreamBodyReader(),
        /**
         * How an `ApiEndUserError` is answered: 266 for a GUI edge, `edgeHttpStatus` (or 400) for a
         * partner-facing API edge. Chosen via `WebpiecesExpressRouter.setEndUserStatus`; see
         * {@link EndUserStatus}.
         */
        endUserStatus: EndUserStatus = 'gui',
    ) {
        this.errorWireMapper = new ApiErrorHttpMapper(endUserStatus);
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
        // 0. PUBLISH the transport-neutral request BEFORE anything that can throw.
        //
        //    This is the ordering bug issue #862 was filed for. An app's ErrorTranslators.toWire has
        //    to be able to tell WHICH request it is answering for — the surface, the route, the
        //    method — and the only place that lives is RequestContext.getRequest(). Publishing it at
        //    step 3 (below) meant a body that failed to parse at step 1 reached handleError with an
        //    EMPTY scope, so a translator asked "is this my surface?" could only answer "I don't
        //    know" and step aside. The translator was never too late; the context it needs was.
        //
        //    No `raw` yet — the bytes have not been read. Step 3 republishes WITH them, below the
        //    same request scope and still above the filter chain, so @WpAuthWebhook signature
        //    verification sees exactly what it saw before.
        //
        //    KNOWN ISSUE, ACCEPTED AND NOT FIXED (issue #862): this publishes the request but does
        //    NOT mint the transaction id — that is `fillFromRequest`'s job and it stays at step 3,
        //    below the body read. So a caller whose body is malformed or oversize, and who sent no
        //    x-request-id of its own, gets an error response with NO transaction id to quote at
        //    support. Moving the whole fill up here would drag the raw-body republish into every
        //    route, which is the complexity this change deliberately declines. Pinned by a test so a
        //    future change to it is a decision rather than an accident.
        RequestContext.setRequest(this.toWebpiecesRequest(req));

        // 1. Parse the request body (see parseBody: the PARSER is chosen by the @Endpoint
        //    annotation, never by the request Content-Type header).
        const parsed = await this.parseBody(req);

        // 2. Translate express's request into the transport-neutral HttpRequest webpieces speaks —
        //    now WITH the raw bytes, when the route asked for them.
        const httpRequest = this.toWebpiecesRequest(req, parsed.raw);

        // 3. Re-publish the transport-neutral HttpRequest, then move its headers into the context and
        //    mint a request id if the caller sent none. BOTH happen above the api boundary, because
        //    http-routing requires an already-established, already-filled request scope — it never
        //    builds one for you. This is the "translation layer" every transport must provide.
        this.headers.fillFromRequest(httpRequest);

        // 4. Invoke the api CLIENT method — the SAME proxy tests use. Its filter chain + controller
        //    run here, reading the context filled above; the chain never touches express `req`.
        const args = this.routeMeta
            ? HttpContractMapper.fromWire(
                  this.routeMeta.parameterBindings,
                  this.routeMeta.bodyParameterIndex,
                  parsed.requestDto,
                  this.pathValues(req),
                  this.queryValues(req),
              )
            : [parsed.requestDto];
        const result = await this.clientMethod(...args);

        // 5. The contract chooses body-only 200 JSON or caller-owned status/headers/body.
        if (this.routeMeta?.responseType === 'full') {
            if (!(result instanceof HttpResponseDto)) {
                throw new ApiImplementationError(
                    `${this.routeMeta.apiName}.${this.routeMeta.methodName} declares responseType:'full' ` +
                        `but returned ${result instanceof Object ? result.constructor.name : typeof result}; ` +
                        `return HttpResponseDto.`,
                );
            }
            this.send(res, result);
            return;
        }
        if (result instanceof HttpResponseDto) {
            throw new ApiImplementationError(
                `${this.routeMeta?.apiName ?? 'API'}.${this.routeMeta?.methodName ?? 'method'} returned ` +
                    `HttpResponseDto but its @Endpoint does not declare responseType:'full'.`,
            );
        }
        this.send(res, new HttpResponseDto(new HttpResponseStatus(200, 'OK'), [], result));
    }

    /**
     * Read and parse the request body: the DTO the controller receives, plus the verbatim
     * {@link RawRequest} when the route asked for one.
     *
     * The PARSER is chosen by the `@Endpoint` annotation (`this.formPost`), NOT by the request
     * Content-Type header — the annotation is the single source of truth.
     */
    private async parseBody(req: Request): Promise<ParsedBody> {
        if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
            return new ParsedBody({}, undefined);
        }

        // Read BYTES, not text. Concatenating per-chunk toString() corrupted any multi-byte
        // character that straddled a chunk boundary — invisible on small bodies, and fatal for a
        // signature computed over the bytes.
        const bodyBytes = await this.bodyReader.read(req, this.maxBodyBytes);
        const bodyText = bodyBytes.toString('utf8');
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        let requestDto: unknown;
        let parseError: Error | undefined;
        if (this.formPost) {
            // application/x-www-form-urlencoded → flat key→value. URLSearchParams is lenient
            // (never throws) — right for EXTERNAL webhooks (e.g. Twilio) that post form-encoded.
            requestDto = this.formBody(bodyText);
        } else {
            const json = this.parseJson(bodyText);
            requestDto = json.requestDto;
            parseError = json.parseError;
        }

        const raw = this.rawBody
            ? new RawRequest(
                  this.absoluteUrl(req),
                  bodyBytes,
                  req.socket?.remoteAddress,
                  parseError,
              )
            : undefined;
        return new ParsedBody(requestDto, raw);
    }

    /**
     * JSON (the default, SYMMETRIC with the client's JSON.stringify). A non-JSON body is a CLIENT
     * error → 400, not the raw 500 an unguarded JSON.parse would throw.
     *
     * On a raw-body (webhook) route the failure is HELD, not thrown: AuthFilter must answer 401 to an
     * unauthenticated caller rather than 400, because "your JSON was bad" tells that caller it got
     * past auth. Everywhere else, fail now.
     */
    private parseJson(bodyText: string): ParsedBody {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- translate parse failure to an ApiBadRequestError
        try {
            return new ParsedBody(bodyText ? JSON.parse(bodyText) : {}, undefined);
        } catch (err: unknown) {
            const error = toError(err);
            if (!this.rawBody) {
                throw new ApiBadRequestError(
                    'Request body is not valid JSON',
                    undefined,
                    undefined,
                    error,
                );
            }
            return new ParsedBody({}, undefined, error);
        }
    }

    /** Preserve repeated form keys as arrays while keeping the historical flat scalar shape. */
    private formBody(bodyText: string): Record<string, string | string[]> {
        const result: Record<string, string | string[]> = {};
        new URLSearchParams(bodyText).forEach((value: string, key: string) => {
            const existing = result[key];
            if (existing === undefined) result[key] = value;
            else if (Array.isArray(existing)) existing.push(value);
            else result[key] = [existing, value];
        });
        return result;
    }

    /** Express has already URL-decoded route placeholders by the time a handler runs. */
    private pathValues(req: Request): Map<string, string | readonly string[]> {
        const values = new Map<string, string | readonly string[]>();
        const params = req.params ?? {};
        for (const name of Object.keys(params)) {
            values.set(name, params[name]);
        }
        return values;
    }

    /** Parse the original query string so repeated keys survive instead of being collapsed. */
    private queryValues(req: Request): Map<string, string | readonly string[]> {
        const values = new Map<string, string | readonly string[]>();
        const rawUrl = req.originalUrl ?? req.url ?? '';
        const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
        new URLSearchParams(query).forEach((value: string, name: string) => {
            const existing = values.get(name);
            if (existing === undefined) values.set(name, value);
            else if (typeof existing === 'string') values.set(name, [existing, value]);
            else values.set(name, [...existing, value]);
        });
        return values;
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
        return new HttpRequest(
            req.method,
            req.path ?? this.path,
            this.readExpressHeaders(req),
            raw,
        );
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
     * Turn a thrown value into the response the caller sees — the SERVER half of webpieces' symmetric
     * error handling (the CLIENT half is `ClientErrorTranslator.translateError`, and the two speak the
     * same {@link HttpResponseDto}).
     *
     * PUBLIC so wrapExpress can call it for symmetric error handling.
     *
     * Two sources, in this order:
     *   1. the app's {@link ErrorTranslators}, if it claims the error — it owns the ENTIRE response;
     *   2. else {@link ApiErrorHttpMapper.toResponse}, the webpieces default, which maps every
     *      `ApiError` subclass to its status (an `ApiEndUserError` per this wrapper's
     *      {@link EndUserStatus}) and a CALLER-SAFE body (only `ApiEndUserError`'s message
     *      is written for a human, so only it goes out verbatim; everything else sends the generic
     *      reason phrase and logs the real one) and turns anything else into a generic 500.
     *
     * Nothing status-specific is decided here any more — read `ApiErrorHttpMapper` for the full rule
     * and the list of statuses, which must stay in step with `ClientErrorTranslator`'s built-in
     * mapping.
     */
    // webpieces-disable no-any-unknown -- a thrown value is genuinely unknown until toError narrows it
    public handleError(res: Response, thrown: unknown): void {
        if (res.headersSent) {
            return;
        }

        // ONE narrowing, at the top, and every layer below it is honest about holding an `Error`.
        const error = toError(thrown);
        // The app's ErrorTranslators own the WHOLE response — status code, reason phrase, headers
        // and body — so an app can publish its own envelope AND its own `Retry-After` /
        // `WWW-Authenticate` / trace header / cookie, which the old (statusCode, protocolError) pair
        // could not express at all. A registered translator REPLACES this default and declines by
        // delegating back to it, so there is no per-error "not mine" branch here: the only question
        // is whether this process installed one.
        const translators = ClientRegistry.getErrorTranslators();
        this.send(
            res,
            translators ? translators.toWire(error) : this.errorWireMapper.toResponse(error),
        );
    }

    /**
     * Stamp the transaction id and hand the DTO to the shared {@link ExpressResponseWriter} — the
     * ONE place a response DTO becomes bytes, used by the app's translators, by webpieces' own
     * default, and by the MCP pre-SDK boundary alike.
     */
    private send(res: Response, response: HttpResponseDto): void {
        this.stampTransactionId(res);
        this.responseWriter.write(res, response);
    }

    /**
     * Put the transaction id on EVERY response — success and error, webpieces' default body and an
     * app's own. It is INFRASTRUCTURE, not app policy: an app that overrides what an error looks like
     * must not thereby lose the header its support desk quotes back. That is why this lives here and
     * not in {@link ApiErrorHttpMapper.toResponse} or in an app's translators.
     *
     * Silently absent when there is no id to send, which is exactly the accepted known issue recorded
     * at step 0 of {@link executeImpl}: a malformed or oversize body fails before `fillFromRequest`
     * mints one.
     */
    private stampTransactionId(res: Response): void {
        if (!RequestContext.isActive()) {
            return;
        }
        const txId = RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID);
        if (txId) {
            res.setHeader(WebpiecesCoreHeaders.REQUEST_ID.httpHeader!, txId);
        }
    }
}
