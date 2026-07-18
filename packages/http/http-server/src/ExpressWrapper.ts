import { Request, Response, NextFunction } from 'express';
import {
    ProtocolError,
    ClientRegistry,
    HttpError,
    HttpBadRequestError,
    HttpVendorError,
    HttpUserError,
    HttpNotFoundError,
    HttpTimeoutError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpInternalServerError,
    HttpBadGatewayError,
    HttpGatewayTimeoutError,
    toError,
    LogManager,
} from '@webpieces/core-util';
import { RequestContext, HttpRequest, RequestContextHeaders } from '@webpieces/core-context';

// The logging backend prepends this logger name to every line, so messages below carry NO
// "[ExpressWrapper]" literal of their own — that would print the name twice.
const log = LogManager.getLogger('ExpressWrapper');

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
        // 1. Translate express's request into the transport-neutral HttpRequest webpieces speaks.
        const httpRequest = this.toWebpiecesRequest(req);

        // 2. Parse the request body. The PARSER is chosen by the @Endpoint annotation (this.formPost),
        //    NOT the request Content-Type header — the annotation is the single source of truth.
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        let requestDto: unknown = {};
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            const bodyText = await this.readRequestBody(req);
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
                    throw new HttpBadRequestError('Request body is not valid JSON', undefined, undefined, error);
                }
            }
        }

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
    private toWebpiecesRequest(req: Request): HttpRequest {
        return new HttpRequest(req.method, this.path, this.readExpressHeaders(req));
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
     * Read raw request body as text.
     * Used to manually parse JSON (instead of express.json() middleware).
     */
    private async readRequestBody(req: Request): Promise<string> {
        return new Promise((resolve: (body: string) => void, reject: (err: Error) => void) => {
            let body = '';
            req.on('data', (chunk: Buffer) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                resolve(body);
            });
            req.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    /**
     * Handle errors - translate to JSON ProtocolError (SYMMETRIC with ClientErrorTranslator).
     * PUBLIC so wrapExpress can call it for symmetric error handling.
     * Maps HttpError subclasses to appropriate HTTP status codes and ProtocolError response.
     *
     * Maps all HttpError types (must match ClientErrorTranslator.translateError()):
     * - HttpUserError → 266 (with errorCode)
     * - HttpBadRequestError → 400 (with field, guiAlertMessage)
     * - HttpUnauthorizedError → 401
     * - HttpForbiddenError → 403
     * - HttpNotFoundError → 404
     * - HttpTimeoutError → 408
     * - HttpInternalServerError → 500
     * - HttpBadGatewayError → 502
     * - HttpGatewayTimeoutError → 504
     * - HttpVendorError → 598 (with waitSeconds)
     */
    // webpieces-disable no-any-unknown -- a thrown error is genuinely unknown until narrowed below
    public handleError(res: Response, error: unknown): void {
        if (res.headersSent) {
            return;
        }

        // App-registered translations win, so an app can serialize its OWN error types (e.g. a
        // custom 460) AND override built-ins. `undefined` means "not mine" — fall through to the
        // built-in instanceof-HttpError ladder below, which stays the generic default. Symmetric
        // with the client's ClientErrorTranslator, which consults tryTranslateFromWire() first.
        if (error instanceof Error) {
            const wire = ClientRegistry.tryTranslateToWire(error);
            if (wire !== undefined) {
                res.status(wire.statusCode)
                    .setHeader('Content-Type', 'application/json')
                    .send(JSON.stringify(wire.protocolError));
                return;
            }
        }

        const protocolError = new ProtocolError();

        if (error instanceof HttpError) {
            // Set common fields for all HttpError types
            protocolError.message = error.message;
            protocolError.subType = error.subType;
            protocolError.name = error.name;

            // Set type-specific fields (MUST match ClientErrorTranslator)
            if (error instanceof HttpUserError) {
                log.info(`User Error: ${error.message}`);
                protocolError.errorCode = error.errorCode;
            } else if (error instanceof HttpBadRequestError) {
                log.info(`Bad Request: ${error.message}`);
                protocolError.field = error.field;
                protocolError.guiAlertMessage = error.guiMessage;
            } else if (error instanceof HttpNotFoundError) {
                log.info(`Not Found: ${error.message}`);
            } else if (error instanceof HttpTimeoutError) {
                log.error(`Timeout Error: ${error.message}`);
            } else if (error instanceof HttpVendorError) {
                log.error(`Vendor Error: ${error.message}`);
                protocolError.waitSeconds = error.waitSeconds;
            } else if (error instanceof HttpUnauthorizedError) {
                log.info(`Unauthorized: ${error.message}`);
            } else if (error instanceof HttpForbiddenError) {
                log.info(`Forbidden: ${error.message}`);
            } else if (error instanceof HttpInternalServerError) {
                log.error(`Internal Server Error: ${error.message}`);
            } else if (error instanceof HttpBadGatewayError) {
                log.error(`Bad Gateway: ${error.message}`);
            } else if (error instanceof HttpGatewayTimeoutError) {
                log.error(`Gateway Timeout: ${error.message}`);
            } else {
                log.info(`Generic HttpError: ${error.message}`);
            }

            // Serialize ProtocolError to JSON (SYMMETRIC with client)
            const responseJson = JSON.stringify(protocolError);
            res.status(error.code).setHeader('Content-Type', 'application/json').send(responseJson);
        } else {
            // Unknown error - 500
            const err = toError(error);
            protocolError.message = 'Internal Server Error';
            log.error('Unexpected error:', err);
            const responseJson = JSON.stringify(protocolError);
            res.status(500).setHeader('Content-Type', 'application/json').send(responseJson);
        }
    }
}
