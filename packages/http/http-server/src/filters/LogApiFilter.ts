import { injectable } from 'inversify';
import { provideSingleton, MethodMeta } from '@webpieces/http-routing';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import {
    HttpBadRequestError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpNotFoundError,
    HttpUserError,
} from '@webpieces/http-api';

/**
 * LogApiFilter - Structured API logging for all requests/responses.
 * Priority: 130 (just below ContextFilter at 140, with gap for custom context filters)
 *
 * Logging patterns:
 * - [API-SVR-req] 'Class.method / url' request=jsonStringOfRequest
 * - [API-SVR-resp-SUCCESS] 'Class.method / url' response=jsonStringOfResponse
 * - [API-SVR-resp-FAIL] 'Class.method / url' error=... (server errors: 500, 502, 504)
 * - [API-SVR-resp-OTHER] 'Class.method / url' errorType=... (user errors: 400, 401, 403, 404, 266)
 *
 * User errors (HttpBadRequestError, etc.) are logged as OTHER, not FAIL,
 * because they are expected behavior from the server's perspective.
 */
@provideSingleton()
@injectable()
export class LogApiFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        const classMethod = this.getClassMethod(meta);
        const url = meta.path;

        // Log request
        this.logRequest(classMethod, url, meta.requestDto);

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Filter logs errors before re-throwing to global handler
        try {
            const response = await nextFilter.invoke(meta);

            // Log success response
            this.logSuccessResponse(classMethod, url, response);

            return response;
        } catch (err: any) {
            //const error = toError(err);
            // Log error and re-throw (jsonTranslator will handle serialization)
            this.logException(classMethod, url, err);
            throw err;
        }
    }

    /**
     * Get formatted class.method string for logging.
     */
    private getClassMethod(meta: MethodMeta): string {
        const className = meta.routeMeta.controllerClassName ?? 'Unknown';
        return `${className}.${meta.methodName}`;
    }

    /**
     * Log incoming request.
     */
    private logRequest(classMethod: string, url: string, request: unknown): void {
        console.log(`[API-SVR-req] '${classMethod} ${url}' request=${JSON.stringify(request)}`);
    }

    /**
     * Log successful response.
     */
    private logSuccessResponse(classMethod: string, url: string, response: WpResponse<unknown>): void {
        console.log(
            `[API-SVR-resp-SUCCESS] '${classMethod} ${url}' response=${JSON.stringify(response.response)}`,
        );
    }

    /**
     * Log exception based on error type.
     * User errors get OTHER (no stack trace), server errors get FAIL.
     */
    private logException(classMethod: string, url: string, error: unknown): void {
        if (this.isUserError(error)) {
            // User errors (400, 401, 403, 404, 266) - no stack trace needed
            const errorType = (error as Error)?.constructor.name ?? 'UnknownError';
            console.log(`[API-SVR-resp-OTHER] '${classMethod} ${url}' errorType=${errorType}`);
        } else {
            // Server errors (500, 502, etc.) - log full details
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[API-SVR-resp-FAIL] '${classMethod} ${url}' error=${errorMessage}`);
        }
    }

    /**
     * Check if error is a user error (expected behavior from server perspective).
     * These are NOT failures - just users making mistakes or validation issues.
     */
    private isUserError(error: unknown): boolean {
        return (
            error instanceof HttpBadRequestError ||
            error instanceof HttpUnauthorizedError ||
            error instanceof HttpForbiddenError ||
            error instanceof HttpNotFoundError ||
            error instanceof HttpUserError
        );
    }
}
