import {
    ApiBadRequestError,
    ApiCodedError,
    ApiConflictError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiEndUserError,
    ApiErrorCodec,
    ApiForbiddenError,
    ApiImplementationError,
    ApiNotFoundError,
    ApiNotImplementedError,
    ApiPreconditionFailedError,
    ApiRateLimitedError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
    ApiUnavailableError,
    ApiUnprocessableError,
    ApiUnsupportedMediaTypeError,
    ClientRegistry,
    ApiErrorHttpStatus,
    HttpResponseDto,
} from '@webpieces/core-util';
import { TranslatedFailure } from './TranslatedFailure';
import { UnexpectedApiResponseError } from './UnexpectedApiResponseError';

/** Reconstructs transport-neutral API failures from an HTTP response. */
export class ClientErrorTranslator {
    // webpieces-disable no-function-outside-class -- pure stateless mapping shared by browser and node
    static translateError(response: HttpResponseDto): TranslatedFailure {
        // `undefined` here is PROVENANCE, not a fallback: `TranslatedFailure.appRegistered` is what
        // `NodeProxyClient.adaptDownstreamFailure` reads to tell an app's deliberate claim on a
        // status apart from the framework's generic default for it.
        const custom = ClientRegistry.getErrorTranslators()?.fromWire(response);
        if (custom !== undefined) return new TranslatedFailure(custom, true, response.status.code);
        return new TranslatedFailure(this.builtInError(response), false, response.status.code);
    }

    /** Semantic body kind is authoritative when it agrees with the HTTP adapter status. */
    // webpieces-disable no-function-outside-class -- public delegable default mapping
    static builtInError(response: HttpResponseDto): Error {
        if (ApiErrorCodec.isPayload(response.body)) {
            const decoded = ApiErrorCodec.decode(response.body);
            // `statusCode` is the 'coded' kind's own status, the one thing the shared table cannot
            // know. This side legitimately holds an `ApiError` — it just decoded one — which is why
            // `hasCode` stays: it narrows the kind to the published subset `codeFor` accepts.
            const statusCode = decoded instanceof ApiCodedError ? decoded.statusCode : undefined;
            if (
                ApiErrorHttpStatus.hasCode(decoded) &&
                ApiErrorHttpStatus.codeFor(decoded.kind, statusCode) === response.status.code
            )
                return decoded;
            return new ApiImplementationError('Internal Error', undefined, true);
        }
        return this.fromStatus(
            response.status.code,
            this.fallbackMessage(response.body, response.status.reason),
        );
    }

    /** Non-Webpieces responders: named statuses map to their class, any other 100-599 to ApiCodedError. */
    // webpieces-disable no-function-outside-class -- fallback for non-Webpieces HTTP responders
    private static fromStatus(statusCode: number, message: string): Error {
        switch (statusCode) {
            case 266:
                return new ApiEndUserError(message);
            case 400:
                return new ApiBadRequestError(message);
            case 401:
                return new ApiUnauthorizedError(message);
            case 403:
                return new ApiForbiddenError(message);
            case 404:
                return new ApiNotFoundError(message);
            case 408:
                return new ApiRequestTimeoutError(message);
            case 409:
                return new ApiConflictError(message);
            case 412:
                return new ApiPreconditionFailedError(message);
            case 415:
                return new ApiUnsupportedMediaTypeError(message);
            case 422:
                return new ApiUnprocessableError(message);
            case 429:
                return new ApiRateLimitedError(message);
            case 500:
                return new ApiImplementationError('Internal Error', undefined, true);
            case 501:
                return new ApiNotImplementedError(message);
            case 502:
                return new ApiDependencyError(message);
            case 503:
                return new ApiUnavailableError(message);
            case 504:
                return new ApiDependencyTimeoutError(message);
            default:
                // Any other real HTTP status keeps its code; only a value no HTTP status can hold is unexpected.
                if (ApiCodedError.isStatusCode(statusCode))
                    return new ApiCodedError(message, statusCode);
                return new UnexpectedApiResponseError(statusCode, message);
        }
    }

    // webpieces-disable no-any-unknown -- HTTP response bodies are app-owned until this boundary safely inspects them
    // webpieces-disable no-function-outside-class -- bounds diagnostic text from a foreign responder
    private static fallbackMessage(body: unknown, reason: string): string {
        if (typeof body === 'object' && body !== null) {
            const message = Object.getOwnPropertyDescriptor(body, 'message')?.value;
            if (typeof message === 'string' && message.length > 0) return message.slice(0, 4096);
        }
        return reason || 'Request Failed';
    }
}
