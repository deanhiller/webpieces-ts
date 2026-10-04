import 'reflect-metadata';
import { MaskSpec, MaskMode } from './LogFieldMask';
import {
    DEFAULT_CALLER_KIND,
    ENDPOINT_CALLER_KEY,
    ExternalCaller,
    getEndpointCaller,
} from './external-caller';
// The TYPE layer these decorators attach — split out for file size only (see auth-mode.ts).
import { AuthMeta, AuthMethods, AuthMode } from './auth-mode';
import {
    EndpointOperation,
    EndpointOptions,
    ExternalEndpointOptions,
    READ,
    WRITE_IDEMPOTENT,
    WRITE,
} from './HttpEndpointOptions';
import { GET, HttpMethod, POST } from './HttpContract';
import { AuthorizationDeclaration, AuthorizationType, AUTHORIZATION_METHODS_KEY, getAuthorization } from './authorization';
import { HTTP_PARAMETERS_METADATA_KEY } from './http-parameter-decorators';

export type { EndpointOptions, ExternalEndpointOptions } from './HttpEndpointOptions';
export type { EndpointOperation } from './HttpEndpointOptions';
export { READ, WRITE_IDEMPOTENT, WRITE } from './HttpEndpointOptions';
export type { HttpMethod } from './HttpContract';
export { GET, POST } from './HttpContract';
export { PathParam, QueryParam, getHttpParameterDeclarations } from './http-parameter-decorators';

/**
 * Metadata keys for storing API routing information.
 * These keys are used by both server-side (routing) and client-side (client generation).
 */
export const METADATA_KEYS = {
    API_PATH: 'webpieces:api-path',
    ENDPOINTS: 'webpieces:endpoints',
    AUTH_META: 'webpieces:auth-meta',
    /** Method names carrying one of the canonical authorization decorators. */
    AUTH_METHODS: 'webpieces:auth-methods',
    /** 'rpc' (default, sync request/response) vs 'pubsub' (fire-and-forget cloud task). */
    API_KIND: 'webpieces:api-kind',
    /** Per-method Cloud Tasks queue-name override (set via @Queue). */
    QUEUE_OVERRIDE: 'webpieces:queue-override',
    /** Per-method @Endpoint options (e.g. formPost), parallel to ENDPOINTS. */
    ENDPOINT_OPTIONS: 'webpieces:endpoint-options',
    /** Per-method required HTTP method, parallel to ENDPOINTS. */
    ENDPOINT_HTTP_METHOD: 'webpieces:endpoint-http-method',
    /** Per-method required read/write semantics, parallel to ENDPOINTS. */
    ENDPOINT_OPERATION: 'webpieces:endpoint-operation',
    /** Per-method @Endpoint trigger kind (rpc | cloudtasks | cron | external), parallel to ENDPOINTS. */
    ENDPOINT_KIND: 'webpieces:endpoint-kind',
    /** Per-method declared external CALLER (only for kind 'external'), parallel to ENDPOINTS. */
    ENDPOINT_CALLER: ENDPOINT_CALLER_KEY,
    /** Per-method @MaskLog spec (which DTO fields the LogApiCall path masks). */
    MASK_LOG: 'webpieces:mask-log',
    /** Per-method opt-in metadata for publishing an RPC endpoint as an MCP tool. */
    MCP_TOOLS: 'webpieces:mcp-tools',
    /** Per-method PERMANENT exclusion from MCP, with the reason — see @InvalidEndpointForMcp. */
    MCP_INVALID: 'webpieces:mcp-invalid',
    /** Per-method request/response event metadata for a typed streaming endpoint. */
    STREAM_ENDPOINTS: 'webpieces:stream-endpoints',
    /** Per-method MCP-user authorization, intentionally separate from HTTP hop auth. */
    LOCAL_ONLY: 'webpieces:local-only',
    /** Per-method explicit path/query parameter declarations, keyed by parameter index. */
    HTTP_PARAMETERS: HTTP_PARAMETERS_METADATA_KEY,
};

/** Nominal backing keeps raw string literals out of endpoint declarations. */
enum EndpointKindValue {
    RPC = 'rpc',
    CLOUDTASKS = 'cloudtasks',
    CRON = 'cron',
    EXTERNAL = 'external',
}

/** Short, statically importable decorator arguments. */
export const RPC = EndpointKindValue.RPC;
export const CLOUDTASKS = EndpointKindValue.CLOUDTASKS;
export const CRON = EndpointKindValue.CRON;
export const EXTERNAL = EndpointKindValue.EXTERNAL;

/** Runtime trigger/delivery owner used by validation, architecture, and infrastructure tooling. */
export type EndpointKind = typeof RPC | typeof CLOUDTASKS | typeof CRON | typeof EXTERNAL;

/** Class decorator that sets the shared base path for all endpoints. */
export function ApiPath(basePath: string): ClassDecorator {
    return (target: Function) => {
        if (Reflect.hasMetadata('webpieces:ipc-api-id', target)) {
            throw new Error(
                `Class ${target.name || 'Unknown'} cannot combine @ApiPath with @WpInternal.`,
            );
        }
        Reflect.defineMetadata(METADATA_KEYS.API_PATH, basePath, target);

        // Initialize endpoints map if not exists
        if (!Reflect.hasMetadata(METADATA_KEYS.ENDPOINTS, target)) {
            Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, {}, target);
        }
    };
}

/**
 * Registers `@Endpoint(POST, path, WRITE, RPC)`. Method, operation, and trigger are required enum
 * values. Operation is independent of the HTTP verb. EXTERNAL additionally requires `calledBy`.
 * Each classification rides a parallel metadata map while ENDPOINTS remains method-name -> path.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: typeof EXTERNAL,
    options: ExternalEndpointOptions,
): MethodDecorator;
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: Exclude<EndpointKind, typeof EXTERNAL>,
    options?: EndpointOptions,
): MethodDecorator;
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: EndpointKind,
    options: EndpointOptions = {},
): MethodDecorator {
    validateEndpointClassification(httpMethod, operation, kind);
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        recordEndpointMetadata(
            metadataTarget,
            propertyKey as string,
            httpMethod,
            path,
            operation,
            kind,
            options,
        );
    };
}

// webpieces-disable no-function-outside-class -- runtime validation backs up nominal TS enums
function validateEndpointClassification(
    httpMethod: HttpMethod,
    operation: EndpointOperation,
    kind: EndpointKind,
): void {
    if (!isHttpMethod(httpMethod)) {
        throw new Error(
            `@Endpoint httpMethod must be GET or POST, received '${String(httpMethod)}'.`,
        );
    }
    if (!isEndpointOperation(operation)) {
        throw new Error(
            `@Endpoint operation must be READ, WRITE_IDEMPOTENT, or WRITE, received '${String(operation)}'.`,
        );
    }
    if (!isEndpointKind(kind)) {
        throw new Error(
            `@Endpoint trigger must be RPC, CLOUDTASKS, CRON, or EXTERNAL, received '${String(kind)}'.`,
        );
    }
}

// webpieces-disable no-function-outside-class -- one metadata write shared by the decorator overloads
function recordEndpointMetadata(
    metadataTarget: Function,
    propertyKey: string,
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: EndpointKind,
    options: EndpointOptions,
): void {
    const endpoints: Record<string, string> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, metadataTarget) || {};

    endpoints[propertyKey] = path;

    Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, endpoints, metadataTarget);

    const methods: Record<string, HttpMethod> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_HTTP_METHOD, metadataTarget) || {};
    methods[propertyKey] = httpMethod;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_HTTP_METHOD, methods, metadataTarget);

    const operations: Record<string, EndpointOperation> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPERATION, metadataTarget) || {};
    operations[propertyKey] = operation;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_OPERATION, operations, metadataTarget);

    const kinds: Record<string, EndpointKind> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_KIND, metadataTarget) || {};
    kinds[propertyKey] = kind;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_KIND, kinds, metadataTarget);

    const opts: Record<string, EndpointOptions> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, metadataTarget) || {};
    opts[propertyKey] = options;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, opts, metadataTarget);

    const declared = options as ExternalEndpointOptions;
    if (
        kind !== EXTERNAL ||
        typeof declared.calledBy !== 'string' ||
        declared.calledBy === ''
    )
        return;
    const callers: Record<string, ExternalCaller> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_CALLER, metadataTarget) || {};
    callers[propertyKey] = new ExternalCaller(
        declared.callerKind ?? DEFAULT_CALLER_KIND,
        declared.calledBy,
    );
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_CALLER, callers, metadataTarget);
}

/** Declares request/response DTO field names that API logging must mask at any depth. */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function MaskLog(fields: Record<string, MaskMode>): MethodDecorator {
    const spec = new MaskSpec(fields);
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const specs: Record<string, MaskSpec> =
            Reflect.getMetadata(METADATA_KEYS.MASK_LOG, metadataTarget) || {};
        specs[propertyKey as string] = spec;
        Reflect.defineMetadata(METADATA_KEYS.MASK_LOG, specs, metadataTarget);
    };
}

/**
 * The @MaskLog spec for one method, or undefined if the method declared none (the common case — the
 * caller then logs the DTO verbatim on the plain JSON.stringify fast path).
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointOptions
export function getMaskSpec(apiClass: Function, methodName: string): MaskSpec | undefined {
    const specs: Record<string, MaskSpec> =
        Reflect.getMetadata(METADATA_KEYS.MASK_LOG, apiClass) || {};
    return specs[methodName];
}

/**
 * Shared implementation for every auth decorator. Authorization is deliberately
 * method-only: a class-level default is too easy to miss when reviewing one endpoint.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
function defineAuthMetadata(authMeta: AuthMeta): MethodDecorator {

    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey?: string | symbol, _descriptor?: PropertyDescriptor) => {
        if (propertyKey === undefined) {
            throw new Error(
                'Authorization decorators are method-only; annotate every @Endpoint explicitly.',
            );
        }
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        if (Reflect.hasMetadata('webpieces:ipc-api-id', metadataTarget)) {
            throw new Error(
                `Internal API ${metadataTarget.name || 'Unknown'} cannot use HTTP authorization decorators.`,
            );
        }
        validateNoConflictingDecorators(metadataTarget, propertyKey as string);
        Reflect.defineMetadata(METADATA_KEYS.AUTH_META, authMeta, metadataTarget, propertyKey);
        const methods = new Set<string>(
            Reflect.getMetadata(METADATA_KEYS.AUTH_METHODS, metadataTarget) || [],
        );
        methods.add(propertyKey as string);
        Reflect.defineMetadata(METADATA_KEYS.AUTH_METHODS, [...methods], metadataTarget);
    };
}

/**
 * @WpAuthPublic(reason) - endpoint intentionally requires no authentication.
 * The non-empty reason makes anonymous exposure an explicit review decision.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthPublic(reason: string): MethodDecorator {
    if (typeof reason !== 'string' || reason.trim() === '') {
        throw new Error(
            '@WpAuthPublic requires a non-empty reason explaining why anonymous access is required.',
        );
    }
    return defineAuthMetadata(new AuthMeta([{ kind: 'public' }], reason));
}

/** Protected network ingress: authenticate one declared credential, then authorize independently. */
// webpieces-disable no-function-outside-class -- canonical method decorator factory
export function WpAuth(methods: AuthMethods): MethodDecorator {
    return defineAuthMetadata(new AuthMeta(methods, undefined));
}

/** Locality is independent of authentication and cannot prove a user or machine identity. */
// webpieces-disable no-function-outside-class -- canonical method decorator factory
export function WpLocalOnly(): MethodDecorator {
    return (target: object, methodName: string | symbol) => {
        if (methodName === undefined) throw new Error('@WpLocalOnly is method-only.');
        Reflect.defineMetadata(METADATA_KEYS.LOCAL_ONLY, true, target.constructor, methodName);
    };
}

// webpieces-disable no-function-outside-class -- canonical metadata reader
export function isLocalOnly(apiClass: Function, methodName: string): boolean {
    return Reflect.getMetadata(METADATA_KEYS.LOCAL_ONLY, apiClass, methodName) === true;
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Get the base path from @ApiPath decorator.
 */
export function getApiPath(apiClass: Function): string | undefined {
    return Reflect.getMetadata(METADATA_KEYS.API_PATH, apiClass);
}

/**
 * Get all endpoints from @Endpoint decorators.
 * Returns a record of methodName -> endpoint path.
 */
export function getEndpoints(apiClass: Function): Record<string, string> | undefined {
    return Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, apiClass);
}

/**
 * Every method's declared trigger kind, as `methodName -> kind`. Parallel to {@link getEndpoints}.
 * Empty for a class carrying no @Endpoint at all.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointKinds(apiClass: Function): Record<string, EndpointKind> {
    return Reflect.getMetadata(METADATA_KEYS.ENDPOINT_KIND, apiClass) || {};
}

/**
 * What triggers ONE method, or undefined when the method carries no @Endpoint.
 *
 * Defaults to nothing rather than to 'rpc': `kind` is a required argument, so a missing entry means
 * "this is not an endpoint", never "an endpoint that forgot to say". Silently defaulting here would
 * put an undeclared cron or webhook back into the graph as a normal rpc call — the exact blindness
 * the required argument exists to remove.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointKind(apiClass: Function, methodName: string): EndpointKind | undefined {
    return getEndpointKinds(apiClass)[methodName];
}

/** The required HTTP method for one endpoint. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointKind
export function getEndpointHttpMethod(apiClass: Function, methodName: string): HttpMethod {
    const methods: Record<string, HttpMethod> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_HTTP_METHOD, apiClass) || {};
    const method = methods[methodName];
    if (!isHttpMethod(method)) {
        throw new Error(
            `@Endpoint ${apiClass.name || 'Unknown'}.${methodName} must declare GET or POST.`,
        );
    }
    return method;
}

/**
 * Get the @Endpoint options for one method (empty object if the method had no options).
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointOptions(apiClass: Function, methodName: string): EndpointOptions {
    const opts: Record<string, EndpointOptions> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, apiClass) || {};
    const options = opts[methodName];
    if (!options && getEndpoints(apiClass)?.[methodName] === undefined) {
        // Preserve the historical helper behavior for a method that is not an endpoint at all.
        return {} as EndpointOptions;
    }
    return options ?? {};
}

/** Read one endpoint's required side-effect semantics. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointOptions
export function getEndpointOperation(apiClass: Function, methodName: string): EndpointOperation {
    const operations: Record<string, EndpointOperation> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPERATION, apiClass) || {};
    const operation = operations[methodName];
    if (!isEndpointOperation(operation)) {
        throw new Error(
            `@Endpoint ${apiClass.name || 'Unknown'}.${methodName} must declare READ, ` +
                'WRITE_IDEMPOTENT, or WRITE.',
        );
    }
    return operation;
}

// webpieces-disable no-function-outside-class -- runtime backstop for JavaScript and `as any` callers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an endpoint operation
function isEndpointOperation(value: unknown): value is EndpointOperation {
    return (
        value === READ ||
        value === WRITE_IDEMPOTENT ||
        value === WRITE
    );
}

// webpieces-disable no-function-outside-class -- runtime backstop for JavaScript and `as any` callers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an HTTP method
function isHttpMethod(value: unknown): value is HttpMethod {
    return value === GET || value === POST;
}

// webpieces-disable no-function-outside-class -- runtime backstop for JavaScript and `as any` callers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an endpoint kind
function isEndpointKind(value: unknown): value is EndpointKind {
    return (
        value === RPC ||
        value === CLOUDTASKS ||
        value === CRON ||
        value === EXTERNAL
    );
}

/**
 * Fail-fast at wiring time when an `external` endpoint declared no caller. The {@link Endpoint}
 * overloads already make that a COMPILE error; this is the backstop for the ways TS is bypassed —
 * a JS caller, an `as any` options object, a hand-rolled Reflect.defineMetadata.
 * @throws Error naming the first external endpoint with no `calledBy`.
 */
// webpieces-disable no-function-outside-class -- wiring-time assert, sibling of assertEveryEndpointHasAuthMode
export function assertEveryExternalEndpointDeclaresCaller(apiClass: Function): void {
    const kinds = getEndpointKinds(apiClass);
    for (const methodName of Object.keys(kinds)) {
        if (
            kinds[methodName] !== 'external' ||
            getEndpointCaller(apiClass, methodName) !== undefined
        )
            continue;
        throw new Error(
            `External endpoint '${methodName}' in ${apiClass.name || 'Unknown'} declares no caller. Say WHO ` +
                `posts to it: @Endpoint(POST, path, WRITE, EXTERNAL, { calledBy: '<vendor>' }) — the runtime architecture ` +
                `graph cannot name an inbound caller it was never told about.`,
        );
    }
}

/**
 * True when the method's @Endpoint declared `{ formPost: true }` — its body is
 * application/x-www-form-urlencoded (flat), not JSON.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function isFormPost(apiClass: Function, methodName: string): boolean {
    return getEndpointOptions(apiClass, methodName).formPost === true;
}

/**
 * True when the method's @Endpoint declared `{ rawBody: true }` — the transport must retain the
 * verbatim bytes + absolute url for an {@link WpAuthWebhook} hook to verify.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of isFormPost
export function isRawBody(apiClass: Function, methodName: string): boolean {
    return getEndpointOptions(apiClass, methodName).rawBody === true;
}

/**
 * Fail-fast at wiring time when an `webhook(...)` endpoint did not ask the transport to keep the
 * bytes it is supposed to verify. A hook with nothing to verify is a MISCONFIGURATION, and it must
 * surface at startup, naming the fix — not as a 401 in production on exactly the traffic the endpoint
 * exists for.
 *
 * This pairing is a runtime assert rather than a type because the two halves live on DIFFERENT
 * decorators (`webhook(...)` and `@Endpoint`), and no union over one decorator's argument can say
 * anything about the other's.
 *
 * @throws Error naming the first `webhook(...)` endpoint missing `{ rawBody: true }`.
 */
// webpieces-disable no-function-outside-class -- wiring-time assert, sibling of assertEveryEndpointHasAuthMode
export function assertEveryWebhookEndpointRetainsRawBody(apiClass: Function): void {
    const endpoints = getEndpoints(apiClass) || {};
    for (const methodName of Object.keys(endpoints)) {
        if (
            !getAuthMeta(apiClass, methodName)?.methods.some((method: AuthMode) => method.kind === 'webhook') ||
            isRawBody(apiClass, methodName)
        )
            continue;
        throw new Error(
            `Endpoint '${methodName}' in ${apiClass.name || 'Unknown'} is webhook(...) but its @Endpoint ` +
                `does not declare { rawBody: true }. A webhook hook verifies a signature over the bytes and ` +
                `the url the SENDER transmitted, and without that option the transport parses the body and ` +
                `throws them away — leaving the hook nothing to check.`,
        );
    }
}

/**
 * Check if a class has @ApiPath decorator.
 */
export function isApiPath(apiClass: Function): boolean {
    return Reflect.hasMetadata(METADATA_KEYS.API_PATH, apiClass);
}

/**
 * Get method-level auth metadata. Class-level authorization is forbidden.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader paired with the decorator API
export function getAuthMeta(apiClass: Function, methodName: string): AuthMeta | undefined {
    return Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName);
}

/**
 * The ONE prescription for "this endpoint declares no auth", shared by the two places that raise it
 * (here and http-routing's ApiRoutingFactory) because they had drifted into teaching different menus.
 * A message teaching an incomplete API is the same defect as an API with two spellings: whichever menu
 * the caller hits becomes the API they believe exists. It leads with the ROLE-GATED member on purpose —
 * the first thing offered should not be the widest grant.
 */
export const MISSING_AUTH_DECORATOR_FIX =
    "Declare @WpAuth([jwt(), oidc(...callers), sharedSecret(key), webhook(name), apiKey('regime', [{in: 'header', name: 'x-api-key'}])]) " +
    "or @WpAuthPublic('reason'), and exactly one @WpAuthorization on every endpoint. Add @WpLocalOnly() separately when locality is required.";

/**
 * Fail-fast at wiring time if any endpoint lacks an auth mode. Both the server
 * (ApiRoutingFactory) and the task/rpc clients call this so a missing auth
 * decorator is a startup error, never a silent open endpoint.
 * @throws Error naming the first endpoint with no auth decorator, via {@link MISSING_AUTH_DECORATOR_FIX}.
 */
export function assertEveryEndpointHasAuthMode(apiClass: Function): void {
    const apiName = apiClass.name || 'Unknown';
    const endpoints = getEndpoints(apiClass) || {};
    for (const methodName of Object.keys(endpoints)) {
        if (!getAuthMeta(apiClass, methodName)) {
            throw new Error(
                `Endpoint '${methodName}' in ${apiName} has no auth decorator. ` +
                    MISSING_AUTH_DECORATOR_FIX,
            );
        }
        const policy = getAuthorization(apiClass, methodName);
        if (!policy) throw new Error(`Endpoint '${methodName}' in ${apiName} requires @WpAuthorization.`);
        AuthorizationDeclaration.validate(policy);
        const auth = getAuthMeta(apiClass, methodName)!;
        const isPublic = auth.methods.some((method: AuthMode) => method.kind === 'public');
        if (isPublic !== (policy.authType === AuthorizationType.ANONYMOUS)) {
            throw new Error(`Endpoint '${methodName}' must pair public authentication with ANONYMOUS authorization, or protected authentication with protected/CUSTOM authorization.`);
        }
    }
    const policyMethods: string[] = Reflect.getMetadata(AUTHORIZATION_METHODS_KEY, apiClass) ?? [];
    for (const methodName of policyMethods) {
        if (!(methodName in endpoints)) throw new Error(`Orphan @WpAuthorization on ${apiName}.${methodName}; declare @Endpoint.`);
    }
}

/**
 * Validate that a class/method doesn't have conflicting auth decorators.
 * @throws Error if multiple auth decorators are found on the same target.
 */
// webpieces-disable no-function-outside-class -- shared decorator metadata validation
export function validateNoConflictingDecorators(
    apiClass: Function,
    methodName: string | undefined,
): void {
    const existing = methodName
        ? Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName)
        : Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);

    if (existing) {
        const targetName = apiClass.name || 'Unknown';
        const location = methodName
            ? `method '${methodName}' of ${targetName}`
            : `class ${targetName}`;
        throw new Error(
            `Conflicting auth decorator on ${location}. ` +
                `Exactly one @WpAuth([...]) or @WpAuthPublic('reason') is allowed per endpoint.`,
        );
    }
}
