import { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import { provideFrameworkSingleton, WebpiecesConfig } from '@webpieces/http-routing';
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
} from '@webpieces/core-util';
import { toError } from '@webpieces/core-util';
import { RequestContext, HttpRequest, RequestContextHeaders } from '@webpieces/core-context';
import { LogManager } from '@webpieces/core-util';

const log = LogManager.getLogger('WebpiecesMiddleware');

/**
 * Express route handler function type. Lives in http-server (the express adapter),
 * NOT in the node-only http-routing package, so http-routing stays express-free.
 * Used by WebpiecesExpressRouter to register handlers Express can call.
 */
export type ExpressRouteHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
) => Promise<void>;

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

    public async execute(req: Request, res: Response, next: NextFunction) {
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
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                resolve(body);
            });
            req.on('error', (err) => {
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
                log.info(`[ExpressWrapper] User Error: ${error.message}`);
                protocolError.errorCode = error.errorCode;
            } else if (error instanceof HttpBadRequestError) {
                log.info(`[ExpressWrapper] Bad Request: ${error.message}`);
                protocolError.field = error.field;
                protocolError.guiAlertMessage = error.guiMessage;
            } else if (error instanceof HttpNotFoundError) {
                log.info(`[ExpressWrapper] Not Found: ${error.message}`);
            } else if (error instanceof HttpTimeoutError) {
                log.error(`[ExpressWrapper] Timeout Error: ${error.message}`);
            } else if (error instanceof HttpVendorError) {
                log.error(`[ExpressWrapper] Vendor Error: ${error.message}`);
                protocolError.waitSeconds = error.waitSeconds;
            } else if (error instanceof HttpUnauthorizedError) {
                log.info(`[ExpressWrapper] Unauthorized: ${error.message}`);
            } else if (error instanceof HttpForbiddenError) {
                log.info(`[ExpressWrapper] Forbidden: ${error.message}`);
            } else if (error instanceof HttpInternalServerError) {
                log.error(`[ExpressWrapper] Internal Server Error: ${error.message}`);
            } else if (error instanceof HttpBadGatewayError) {
                log.error(`[ExpressWrapper] Bad Gateway: ${error.message}`);
            } else if (error instanceof HttpGatewayTimeoutError) {
                log.error(`[ExpressWrapper] Gateway Timeout: ${error.message}`);
            } else {
                log.info(`[ExpressWrapper] Generic HttpError: ${error.message}`);
            }

            // Serialize ProtocolError to JSON (SYMMETRIC with client)
            const responseJson = JSON.stringify(protocolError);
            res.status(error.code).setHeader('Content-Type', 'application/json').send(responseJson);
        } else {
            // Unknown error - 500
            const err = toError(error);
            protocolError.message = 'Internal Server Error';
            log.error('[ExpressWrapper] Unexpected error:', err);
            const responseJson = JSON.stringify(protocolError);
            res.status(500).setHeader('Content-Type', 'application/json').send(responseJson);
        }
    }
}

/**
 * WebpiecesMiddleware - Express middleware for WebPieces server.
 *
 * This class contains all Express middleware used by WebpiecesServer:
 * 1. globalErrorHandler - Outermost error handler, returns HTML 500 page
 * 2. logNextLayer - Request/response logging
 * 3. jsonTranslator - JSON Content-Type validation and error translation
 *
 * The middleware is injected into WebpiecesServerImpl and registered with Express
 * in the start() method.
 *
 * IMPORTANT: jsonTranslator does NOT dispatch routes - route dispatch happens via
 * Express's registered route handlers (created by RouteBuilder.createHandler()).
 * jsonTranslator only validates Content-Type and translates errors to JSON.
 *
 * NEW: ExpressWrapper simplified - no longer handles JSON or headers
 * - JSON parsing/serialization moved to JsonFilter
 * - Header transfer moved to ContextFilter (injects PlatformHeadersExtension directly)
 * - ExpressWrapper just creates RouterReqResp and invokes filter chain
 *
 * Extension vs Plugin pattern:
 * - Extensions (DI-level): Contribute capabilities to framework (headers, converters, etc.)
 * - Plugins (App-level): Provide complete features with modules + routes (Hibernate, Jackson, etc.)
 */
@provideFrameworkSingleton()
export class WebpiecesMiddleware {
    /** The ONE wire<->context transfer, handed to every route's ExpressWrapper. Stateless. */
    private readonly headers = new RequestContextHeaders();


    /**
     * Global error handler middleware - catches ALL unhandled errors.
     * Returns HTML 500 error page for any errors that escape the filter chain.
     *
     * This is the outermost safety net - JsonTranslator catches JSON API errors,
     * this catches everything else.
     */
    async globalErrorHandler(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        log.info(`🔴 [Layer 1: GlobalErrorHandler] Request START: ${req.method} ${req.path}`);

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Global error handler IS the top-level catch-all
        try {
            // await next() catches BOTH:
            // 1. Synchronous throws from next() itself
            // 2. Rejected promises from downstream async middleware
            await next();
            log.info(
                `🔴 [Layer 1: GlobalErrorHandler] Request END (success): ${req.method} ${req.path}`,
            );
        } catch (err: unknown) {
            const error = toError(err);
            log.error('🔴 [Layer 1: GlobalErrorHandler] Caught unhandled error:', error);
            if (!res.headersSent) {
                // Return HTML error page (not JSON - JsonTranslator handles JSON errors)
                res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Server Error</title></head>
          <body>
            <h1>You hit a server error</h1>
            <p>An unexpected error occurred while processing your request.</p>
            <pre>${error.message}</pre>
          </body>
          </html>
        `);
            }
            log.info(
                `🔴 [Layer 1: GlobalErrorHandler] Request END (error): ${req.method} ${req.path}`,
            );
        }
    }

    /**
     * Logging middleware - logs request/response flow.
     * Demonstrates middleware execution order.
     * IMPORTANT: Must be async and await next() to properly chain with async middleware.
     */
    async logNextLayer(req: Request, res: Response, next: NextFunction): Promise<void> {
        log.info(`🟡 [Layer 2: LogNextLayer] Before next() - ${req.method} ${req.path}`);
        await next();
        log.info(`🟡 [Layer 2: LogNextLayer] After next() - ${req.method} ${req.path}`);
    }

    /**
     * CORS middleware. DO NOT MOUNT UNCONDITIONALLY — {@link WebpiecesExpressRouter.bindAndStartExpress}
     * mounts it ONLY when {@link WebpiecesConfig.corsOrigins} is non-empty, and that is the point.
     *
     * CORS exists solely to let a browser on a DIFFERENT origin call this api — in practice
     * `ng serve` on :4200 hitting an api on :8080 during development, or a UI hosted on a different
     * host than the api. A server that serves its own browser app needs NO cors at all, because a
     * browser does not apply cors to a same-origin request. So in production this middleware is
     * normally ABSENT, and absent is the safe state: every origin it allows gains the right to make
     * CREDENTIALED cross-origin calls and READ the responses. Mounting it unconditionally (as the
     * old corsForLocalhost did) handed that right to anything on the victim's localhost, in prod,
     * for no benefit whatsoever.
     *
     * When mounted, allows: a request with NO Origin (curl, server-to-server, a CLI); the server's
     * OWN origin; and EXACTLY the origins in `corsOrigins` — nothing is implicit. Anything else gets
     * a clean 403, never the HTML 500 the old `callback(new Error(...))` produced.
     *
     * SAME-ORIGIN MUST STAY ALLOWED even though a same-origin request needs no cors headers, because
     * a browser attaches an `Origin` header to EVERY POST — including a same-origin POST — and every
     * webpieces route is a POST. Once mounted, this middleware SEES that origin, so if it did not
     * allow it, it would 403 the server's own UI. That was the production bug.
     *
     * The same-origin test compares HOST ONLY, deliberately. Behind a TLS-terminating proxy (Cloud
     * Run, any load balancer) `req.protocol` is `http` while the browser's `Origin` says `https`, so
     * comparing full origins would reject the server's own origin on every deploy.
     *
     * @returns Express middleware handler for CORS
     */
    corsMiddleware(config?: WebpiecesConfig): RequestHandler {
        const allowedOrigins = config?.corsOrigins ?? [];
        log.info(
            `[WebpiecesMiddleware] CORS MOUNTED. Allowing same-origin + [${allowedOrigins.join(', ')}]. ` +
                `Every other browser origin gets a 403.`,
        );

        const handler = cors({
            origin: true, // reflect the request origin — we have already vetted it below
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
            allowedHeaders: '*',
            exposedHeaders: '*',
            maxAge: 3600,
        });

        return (req: Request, res: Response, next: NextFunction): void => {
            const origin = req.headers.origin;
            if (!origin) {
                // No Origin -> not a browser cross-origin request; nothing to negotiate.
                next();
                return;
            }
            if (this.isOriginAllowed(origin, req.get('host'), allowedOrigins)) {
                handler(req, res, next);
                return;
            }
            log.info(`[CORS] Blocked origin: ${origin}`);
            res.status(403).json({
                name: 'CorsError',
                message: `CORS not allowed for origin: ${origin}`,
            });
        };
    }

    /**
     * Same-origin (HOST ONLY — see corsMiddleware() on why the scheme is deliberately ignored), or an
     * explicit entry in corsOrigins. NOTHING is implicit: localhost is allowed only if the config
     * asked for it, so a production server that enables cors for a cross-host UI does not silently
     * open the door to localhost as well.
     */
    private isOriginAllowed(origin: string, host: string | undefined, allowedOrigins: string[]): boolean {
        let originHost: string;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a malformed Origin is untrusted browser input, not a server fault; it must become a 403 here, never bubble to the 500 chokepoint
        try {
            originHost = new URL(origin).host;
        } catch (err: unknown) {
            const error = toError(err);
            log.info(`[CORS] Malformed Origin header '${origin}': ${error.message}`);
            return false;
        }
        if (host !== undefined && originHost === host) {
            return true; // same-origin: the server's own UI calling its own api
        }
        return allowedOrigins.some((allowed: string): boolean => this.matchesOrigin(origin, allowed));
    }

    /**
     * Exact origin match, except a `*` in the PORT position matches any port: `http://localhost:*`
     * is what a developer writes, because the angular dev-server port moves around.
     *
     * The `*` is deliberately NOT a general wildcard — it never spans a host, and what follows the
     * prefix must be a real (digits-only) port. So `http://localhost:*` cannot be tricked into
     * matching `http://localhost.evil.com`, and a bare `*` matches nothing at all.
     */
    private matchesOrigin(origin: string, allowed: string): boolean {
        if (allowed === origin) {
            return true;
        }
        const wildcardSuffix = ':*';
        if (!allowed.endsWith(wildcardSuffix)) {
            return false;
        }
        const prefix = allowed.slice(0, -wildcardSuffix.length);
        if (!origin.startsWith(`${prefix}:`)) {
            return false;
        }
        const port = origin.slice(prefix.length + 1);
        return /^\d+$/.test(port);
    }

    /**
     * Create an ExpressWrapper for a route.
     * The wrapper handles the full request/response cycle (symmetric design): it publishes the
     * HttpRequest + fills the context, then invokes the api client method (the proxy).
     *
     * @param clientMethod - The api client's method for this route (dto → response); the proxy
     *   runs the filter chain + controller.
     * @param path - The route path (used to build the HttpRequest).
     * @param formPost - True for an @Endpoint(..., { formPost: true }) route (parse body as
     *   urlencoded, not JSON). Default false = JSON.
     * @returns ExpressWrapper instance
     */
    createExpressWrapper(
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        clientMethod: (requestDto: unknown) => Promise<unknown>,
        path: string,
        formPost: boolean = false,
    ): ExpressWrapper {
        return new ExpressWrapper(clientMethod, path, this.headers, formPost);
    }
}
