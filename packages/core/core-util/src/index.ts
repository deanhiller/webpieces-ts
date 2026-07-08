/**
 * @webpieces/core-util
 *
 * Utility functions for WebPieces applications.
 * This package works in both browser and Node.js environments.
 *
 * @packageDocumentation
 */

export { toError } from './lib/errorUtils';
export { ContextKey } from './ContextKey';
export { ContextTuple } from './ContextTuple';

// @DocumentDesign — DI-design-root marker. Applies to ANY project kind (server
// controllers AND library impl classes), so it lives here (browser + Node) rather
// than in a server-only routing package.
export { DocumentDesign, isDocumentDesign, DESIGN_METADATA_KEYS } from './DocumentDesign';

// Logging (merged from former @webpieces/wp-logging).
// Pluggable logging interface + a browser-safe console default; apps plug in
// bunyan/winston/pino/etc. via LogManager.setFactory(...). Browser + Node.
export type { Logger, LogLevel } from './logging/Logger';
export type { LoggerFactory } from './logging/LoggerFactory';
export { ConsoleLogger } from './logging/ConsoleLogger';
export { ConsoleLoggerFactory } from './logging/ConsoleLoggerFactory';
export { LogManager } from './logging/LogManager';

// HTTP API contract (merged from former @webpieces/http-api).
// Shared HTTP API definition consumed by both client and server: REST
// decorators, the HttpError hierarchy, datetime DTOs, platform-header
// registry/readers, ValidateImplementation, and the test-case recorder
// contract. Pure definitions — express-free, browser + Node safe.

// API definition decorators
export {
    ApiPath,
    Endpoint,
    Authentication,
    AuthenticationConfig,
    // Auth mode decorators (clean service-to-service + user JWT model)
    Public,
    AuthJwt,
    Auth,
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
} from './http/decorators';
export type { AuthMode, ApiKind, JwtRequirement } from './http/decorators';
// Client-side shared-secret store (the value THIS service sends per @AuthSharedSecret key).
export { Secrets } from './http/Secrets';

// Type validators
export { ValidateImplementation } from './http/validators';

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
} from './http/errors';

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
} from './http/datetime';

// Context keys + registry (the global magic-context header system)
export { HeaderRegistry } from './http/HeaderRegistry';
export { WebpiecesCoreHeaders } from './http/WebpiecesCoreHeaders';
export { HeaderMethods } from './http/HeaderMethods';
export { ContextReader } from './http/ContextReader';

// Outbound-header machinery (context reader + registry -> outbound HTTP headers).
// Browser-safe — the server-side reader (RequestContextReader) and browser store
// (MutableContextStore) both implement ContextReader, so this lives here rather
// than in the Node-only @webpieces/core-context (which re-exports for back-compat).
export { ContextMgr } from './http/ContextMgr';
export { RequestIdChainProcessor } from './http/RequestIdChainProcessor';

// API-call logging helper (uses LogManager above)
export { LogApiCall } from './http/LogApiCall';

// Test-case recording contract (impl lives in http-server; hooks in http-client)
export { TestCaseRecorder, RecorderKeys } from './http/recorder/TestCaseRecorder';
export { RecordedEndpoint, RecordedError, RecordedTestCase } from './http/recorder/RecordedEndpoint';
export { DoNotRecord, getDoNotRecordFields } from './http/recorder/DoNotRecord';
export { RecordSerializer, SerializedMap, SerializedError } from './http/recorder/RecordSerializer';
