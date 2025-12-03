import { Request, Response, NextFunction } from 'express';
import { injectable } from 'inversify';
import { provideSingleton, MethodMeta, ExpressRouteHandler } from '@webpieces/http-routing';
import {
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpVendorError,
    HttpUserError,
    RouteMetadata,
} from '@webpieces/http-api';
import { Service, WpResponse } from '@webpieces/http-filters';
import { toError } from '@webpieces/core-util';
import { JsonSerializer } from 'typescript-json-serializer';

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
    private jsonSerializer = new JsonSerializer();
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
     * Wrap a Service as an Express route handler.
     *
     * SYMMETRIC DESIGN: This handler owns the FULL request/response cycle:
     * 1. Validates Content-Type
     * 2. Deserializes req.body (plain object) → DTO class instance
     * 3. Creates MethodMeta with deserialized DTO
     * 4. Invokes Service (filter chain + controller)
     * 5. Serializes response (class instance) → plain object
     * 6. WRITES response as JSON to client (SYMMETRIC with reading request!)
     * 7. Handles errors via handleError()
     *
     * @param service - The service wrapping the filter chain and controller
     * @param routeMeta - Route metadata for MethodMeta and DTO type
     * @returns Express-compatible route handler
     */
    wrapExpress(
        service: Service<MethodMeta, WpResponse<unknown>>,
        routeMeta: RouteMetadata,
    ): ExpressRouteHandler {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            try {
                // 1. Get request DTO class from routeMeta
                const requestDtoClass = routeMeta.parameterTypes?.[0];
                if(!requestDtoClass)
                    throw new Error('No request DTO class found for route');

                // 2. Deserialize req.body → DTO instance
                const requestDto = this.jsonSerializer.deserializeObject(req.body, requestDtoClass);
                // 3. Create MethodMeta with deserialized DTO
                const methodMeta = new MethodMeta(routeMeta, requestDto);
                // 4. Invoke the service (filter chain + controller)
                const wpResponse = await service.invoke(methodMeta);
                if(!wpResponse.response)
                    throw new Error(`Route chain(filters & all) is not returning a response.  ${routeMeta.controllerClassName}.${routeMeta.methodName}`);

                // 6. Serialize response → plain object
                const responseDtoStr = this.jsonSerializer.serializeObject(wpResponse.response);

                // 7. WRITE response as JSON (SYMMETRIC with reading request!)
                res.status(200);
                res.setHeader('Content-Type', 'application/json');
                res.json(responseDtoStr);
            } catch (err: unknown) {
                // 8. Handle errors (SYMMETRIC - wrapExpress owns error handling!)
                this.handleError(res, err);
            }
        };
    }


    /**
     * Handle errors - translate to JSON ProtocolError.
     * PUBLIC so wrapExpress can call it for symmetric error handling.
     * Maps HttpError subclasses to appropriate HTTP status codes and ProtocolError response.
     */
    public handleError(res: Response, error: unknown): void {
        if (res.headersSent) {
            return;
        }

        const protocolError = new ProtocolError();

        if (error instanceof HttpError) {
            protocolError.message = error.message;
            protocolError.subType = error.subType;
            protocolError.name = error.name;

            if (error instanceof HttpBadRequestError) {
                protocolError.field = error.field;
                protocolError.guiAlertMessage = error.guiMessage;
            }
            if (error instanceof HttpVendorError) {
                protocolError.waitSeconds = error.waitSeconds;
            }
            if (error instanceof HttpUserError) {
                protocolError.errorCode = error.errorCode;
            }

            res.status(error.code).json(protocolError);
        } else {
            // Unknown error - 500
            const err = toError(error);
            protocolError.message = 'Internal Server Error';
            console.error('[JsonTranslator] Unexpected error:', err);
            res.status(500).json(protocolError);
        }
    }
}
