import { Request, Response, NextFunction } from 'express';
import { injectable } from 'inversify';
import { provideSingleton, MethodMeta, ExpressRouteHandler } from '@webpieces/http-routing';
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
    RouteMetadata,
} from '@webpieces/http-api';
import { Service, WpResponse } from '@webpieces/http-filters';
import { toError } from '@webpieces/core-util';

export class ExpressWrapper {
    constructor(
        private service: Service<MethodMeta, WpResponse<unknown>>,
        private routeMeta: RouteMetadata
    ) {
    }

    public async execute(req: Request, res: Response, next: NextFunction) {
        try {
            // 1. Parse JSON request body manually (SYMMETRIC with client's JSON.stringify)
            let requestDto: unknown = {};
            if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
                // Read raw body as text
                const bodyText = await this.readRequestBody(req);
                // Parse JSON
                requestDto = bodyText ? JSON.parse(bodyText) : {};
            }

            // 2. Create MethodMeta with request DTO
            const methodMeta = new MethodMeta(this.routeMeta, requestDto);

            // 3. Invoke the service (filter chain + controller)
            const wpResponse = await this.service.invoke(methodMeta);
            if(!wpResponse.response)
                throw new Error(`Route chain(filters & all) is not returning a response.  ${this.routeMeta.controllerClassName}.${this.routeMeta.methodName}`);

            // 4. Serialize response DTO to JSON (SYMMETRIC with client's response.json())
            const responseJson = JSON.stringify(wpResponse.response);
            res.status(200).setHeader('Content-Type', 'application/json').send(responseJson);
        } catch (err: unknown) {
            // 5. Handle errors
            this.handleError(res, err);
        }
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
                console.log('[ExpressWrapper] User Error:', error.message);
                protocolError.errorCode = error.errorCode;
            } else if (error instanceof HttpBadRequestError) {
                console.log('[ExpressWrapper] Bad Request:', error.message);
                protocolError.field = error.field;
                protocolError.guiAlertMessage = error.guiMessage;
            } else if (error instanceof HttpNotFoundError) {
                console.log('[ExpressWrapper] Not Found:', error.message);
            } else if (error instanceof HttpTimeoutError) {
                console.error('[ExpressWrapper] Timeout Error:', error.message);
            } else if (error instanceof HttpVendorError) {
                console.error('[ExpressWrapper] Vendor Error:', error.message);
                protocolError.waitSeconds = error.waitSeconds;
            } else if (error instanceof HttpUnauthorizedError) {
                console.log('[ExpressWrapper] Unauthorized:', error.message);
            } else if (error instanceof HttpForbiddenError) {
                console.log('[ExpressWrapper] Forbidden:', error.message);
            } else if (error instanceof HttpInternalServerError) {
                console.error('[ExpressWrapper] Internal Server Error:', error.message);
            } else if (error instanceof HttpBadGatewayError) {
                console.error('[ExpressWrapper] Bad Gateway:', error.message);
            } else if (error instanceof HttpGatewayTimeoutError) {
                console.error('[ExpressWrapper] Gateway Timeout:', error.message);
            } else {
                console.log('[ExpressWrapper] Generic HttpError:', error.message);
            }

            // Serialize ProtocolError to JSON (SYMMETRIC with client)
            const responseJson = JSON.stringify(protocolError);
            res.status(error.code).setHeader('Content-Type', 'application/json').send(responseJson);
        } else {
            // Unknown error - 500
            const err = toError(error);
            protocolError.message = 'Internal Server Error';
            console.error('[ExpressWrapper] Unexpected error:', err);
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
 * DI Pattern: This class is registered via @provideSingleton() with no dependencies.
 */
@provideSingleton()
@injectable()
export class WebpiecesMiddleware {

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
        console.log('🔴 [Layer 1: GlobalErrorHandler] Request START:', req.method, req.path);

        try {
            // await next() catches BOTH:
            // 1. Synchronous throws from next() itself
            // 2. Rejected promises from downstream async middleware
            await next();
            console.log(
                '🔴 [Layer 1: GlobalErrorHandler] Request END (success):',
                req.method,
                req.path,
            );
        } catch (err: unknown) {
            const error = toError(err);
            console.error('🔴 [Layer 1: GlobalErrorHandler] Caught unhandled error:', error);
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
            console.log(
                '🔴 [Layer 1: GlobalErrorHandler] Request END (error):',
                req.method,
                req.path,
            );
        }
    }

    /**
     * Logging middleware - logs request/response flow.
     * Demonstrates middleware execution order.
     * IMPORTANT: Must be async and await next() to properly chain with async middleware.
     */
    async logNextLayer(req: Request, res: Response, next: NextFunction): Promise<void> {
        console.log('🟡 [Layer 2: LogNextLayer] Before next() -', req.method, req.path);
        await next();
        console.log('🟡 [Layer 2: LogNextLayer] After next() -', req.method, req.path);
    }

    /**
     * Create an ExpressWrapper for a route.
     * The wrapper handles the full request/response cycle (symmetric design).
     *
     * @param service - The service wrapping the filter chain and controller
     * @param routeMeta - Route metadata for MethodMeta and DTO type
     * @returns ExpressWrapper instance
     */
    createExpressWrapper(
        service: Service<MethodMeta, WpResponse<unknown>>,
        routeMeta: RouteMetadata,
    ): ExpressWrapper {
        return new ExpressWrapper(service, routeMeta);
    }
}
