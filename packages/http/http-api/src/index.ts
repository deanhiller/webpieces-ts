/**
 * @webpieces/http-api
 *
 * Core HTTP API definition package.
 * Contains decorators and utilities for defining HTTP APIs.
 *
 * This package is used by:
 * - @webpieces/http-routing (server-side): Routes HTTP requests to controllers
 * - @webpieces/http-client (client-side): Generates HTTP clients from API definitions
 *
 * Architecture:
 * ```
 * http-api (defines the contract)
 *    ↑
 *    ├── http-routing (server: contract → handlers)
 *    └── http-client (client: contract → HTTP requests)
 * ```
 */

// API definition decorators
export {
    ApiPath,
    Endpoint,
    Authentication,
    AuthenticationConfig,
    // Auth mode decorators (clean service-to-service + user JWT model)
    Public,
    AuthJwt,
    AuthOidc,
    AuthSharedSecret,
    // API kind (RPC vs PubSub/Cloud Tasks) + queue naming
    Rpc,
    PubSub,
    Queue,
    getApiPath,
    getEndpoints,
    isApiPath,
    getAuthMeta,
    getAuthMode,
    assertEveryEndpointHasAuthMode,
    getApiKind,
    assertApiKind,
    assertPubSubConventions,
    getQueueName,
    validateNoConflictingDecorators,
    AuthMeta,
    RouteMetadata,
    METADATA_KEYS,
} from './decorators';
export type { AuthMode, ApiKind } from './decorators';

// Type validators
export { ValidateImplementation } from './validators';

// HTTP errors
export {
    ProtocolError,
    HttpError,
    HttpNotFoundError,
    EndpointNotFoundError,
    HttpBadRequestError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpTimeoutError,
    HttpBadGatewayError,
    HttpGatewayTimeoutError,
    HttpInternalServerError,
    HttpVendorError,
    HttpUserError,
    // Error subtype constants
    ENTITY_NOT_FOUND,
    WRONG_LOGIN_TYPE,
    WRONG_LOGIN,
    NOT_APPROVED,
    EMAIL_NOT_CONFIRMED,
    WRONG_DOMAIN,
    WRONG_COMPANY,
    NO_REG_CODE,
} from './errors';

// Date/Time DTOs and Utilities (inspired by Java Time / JSR-310)
export {
    InstantDto,
    DateDto,
    TimeDto,
    DateTimeDto,
    InstantUtil,
    DateUtil,
    TimeUtil,
    DateTimeUtil,
} from './datetime';

// Platform Headers
export { PlatformHeader } from './PlatformHeader';
export { PlatformHeadersExtension } from './PlatformHeadersExtension';
export { HeaderRegistry } from './HeaderRegistry';
export { WebpiecesCoreHeaders } from './WebpiecesCoreHeaders';
export { HeaderMethods } from './HeaderMethods';
export { ContextReader } from './ContextReader';
export { HEADER_TYPES } from './HeaderTypes';

// Logging
export { LogApiCall } from './LogApiCall';

// Re-export core-util error helper so http-client (which depends only on
// http-api) can follow the catch-error pattern without a new dependency
export { toError } from '@webpieces/core-util';

// Test-case recording contract (impl lives in http-server; hooks in http-client)
export { TestCaseRecorder, RecorderKeys } from './recorder/TestCaseRecorder';
export { RecordedEndpoint, RecordedError, RecordedTestCase } from './recorder/RecordedEndpoint';
export { DoNotRecord, getDoNotRecordFields } from './recorder/DoNotRecord';
export { RecordSerializer, SerializedMap, SerializedError } from './recorder/RecordSerializer';
