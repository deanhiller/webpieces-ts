import {PlatformHeader} from "./PlatformHeader";
import {RouteMetadata} from "./decorators";
import {
    HttpBadRequestError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpNotFoundError,
    HttpUserError,
} from './errors';
import {toError} from "@webpieces/core-util";


/**
 * LogApiCall - Generic API call logging utility.
 *
 * Used by both server-side (LogApiFilter) and client-side (ClientFactory) for
 * consistent logging patterns across the framework.
 *
 * Logging format patterns:
 * - [API-{type}-req] ClassName.methodName request={...} headers={...}
 * - [API-{type}-resp-SUCCESS] ClassName.methodName response={...}
 * - [API-{type}-resp-OTHER] ClassName.methodName errorType={...}  (user errors)
 * - [API-{type}-resp-FAIL] ClassName.methodName error={...}  (server errors)
 */
export class LogApiCall {

    /**
     * Execute an API call with logging around it.
     *
     * @param type - 'SVR' or 'CLIENT'
     * @param meta - Route metadata with controllerClassName and methodName
     * @param requestDto - The request DTO
     * @param headers - Map of header name -> values
     * @param splitHeaders - SplitHeaders with secureHeaders and publicHeaders for masking
     * @param method - The method to execute
     */
    public async execute(
        type: string,
        meta: RouteMetadata,
        requestDto: any,
        headers: Map<string, any>,
        method: (dto: any) => Promise<any>
    ): Promise<any> {
        // Log request
        console.log(
            `[API-${type}-req] ${meta.controllerClassName}.${meta.methodName} ${meta.path} request=${JSON.stringify(requestDto)} headers=${JSON.stringify(headers)}`
        );

        try {
            const response = await method(requestDto);

            // Log success response
            console.log(
                `[API-${type}-resp-SUCCESS] ${meta.controllerClassName}.${meta.methodName} response=${JSON.stringify(response)}`
            );

            return response;
        } catch (err: any) {
            const error = toError(err);
            const errorType = error.constructor.name;
            const errorMessage = error.message;

            // Log error based on type and re-throw
            if (LogApiCall.isUserError(error)) {
                console.log(
                    `[API-${type}-resp-OTHER] ${meta.controllerClassName}.${meta.methodName} errorType=${errorType}`
                );
            } else {
                console.error(
                    `[API-${type}-resp-FAIL] ${meta.controllerClassName}.${meta.methodName} errorType=${errorType} error=${errorMessage}`
                );
            }
            throw error;
        }
    }

    /**
     * Check if an error is a user error (expected behavior from server perspective).
     * User errors are NOT failures - just users making mistakes or validation issues.
     *
     * User errors (logged as OTHER, no stack trace):
     * - HttpBadRequestError (400)
     * - HttpUnauthorizedError (401)
     * - HttpForbiddenError (403)
     * - HttpNotFoundError (404)
     * - HttpUserError (266)
     *
     * @param error - The error to check
     * @returns true if this is a user error, false for server errors
     */
    static isUserError(error: unknown): boolean {
        return (
            error instanceof HttpBadRequestError ||
            error instanceof HttpUnauthorizedError ||
            error instanceof HttpForbiddenError ||
            error instanceof HttpNotFoundError ||
            error instanceof HttpUserError
        );
    }
}
