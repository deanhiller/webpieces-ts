import { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import { injectable } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/http-routing';
import {
    ProtocolError,
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

        // 2. Parse JSON request body manually (SYMMETRIC with client's JSON.stringify)
        let requestDto: unknown = {};
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            // Read raw body as text
            const bodyText = await this.readRequestBody(req);
            // Parse JSON
            requestDto = bodyText ? JSON.parse(bodyText) : {};
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
@injectable()
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
     * CORS middleware for localhost development.
     * Only enables CORS when request origin is localhost:*.
     *
     * Wide open for all headers/methods in dev mode.
     * Non-localhost origins are blocked.
     *
     * @returns Express middleware handler for CORS
     */
    corsForLocalhost(): RequestHandler {
        log.info('[WebpiecesMiddleware] CORS enabled for localhost:* origins');

        return cors({
            origin: function (origin, callback) {
                // Allow requests with no origin (same-origin, Postman, curl)
                if (!origin) {
                    callback(null, true);
                    return;
                }

                // Only allow localhost origins
                if (origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) {
                    callback(null, true);
                } else {
                    log.info(`[CORS] Blocked origin: ${origin} (only localhost:* allowed)`);
                    callback(new Error(`CORS not allowed for origin: ${origin}`));
                }
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
            allowedHeaders: '*', // Wide open for dev
            exposedHeaders: '*', // Expose all response headers to browser JS
            maxAge: 3600,
        });
    }

    /**
     * Create an ExpressWrapper for a route.
     * The wrapper handles the full request/response cycle (symmetric design): it publishes the
     * HttpRequest + fills the context, then invokes the api client method (the proxy).
     *
     * @param clientMethod - The api client's method for this route (dto → response); the proxy
     *   runs the filter chain + controller.
     * @param path - The route path (used to build the HttpRequest).
     * @returns ExpressWrapper instance
     */
    createExpressWrapper(
        // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
        clientMethod: (requestDto: unknown) => Promise<unknown>,
        path: string,
    ): ExpressWrapper {
        return new ExpressWrapper(clientMethod, path, this.headers);
    }
}
