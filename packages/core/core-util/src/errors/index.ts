export {
    ApiError,
    ApiNotFoundError,
    ApiDependencyError,
    ApiUnavailableError,
    ApiDependencyTimeoutError,
    ApiImplementationError,
    ApiRateLimitedError,
    ApiForbiddenError,
    ApiRequestTimeoutError,
    ApiConnectionError,
    ApiEndpointNotFoundError,
    ApiEndUserError,
    ApiBadRequestError,
    ApiUnauthorizedError,
    ApiDependencyBackoffError,
} from './ApiError';
export type { ApiErrorKind } from './ApiError';
export { ApiErrorCodec, ApiErrorPayload } from './ApiErrorCodec';
export {
    ENTITY_NOT_FOUND,
    WRONG_LOGIN_TYPE,
    WRONG_LOGIN,
    NOT_APPROVED,
    EMAIL_NOT_CONFIRMED,
    WRONG_DOMAIN,
    WRONG_COMPANY,
    NO_REG_CODE,
} from './AuthErrorSubtypes';
