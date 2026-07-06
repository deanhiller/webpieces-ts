import 'reflect-metadata';

/**
 * Metadata keys for storing API routing information.
 * These keys are used by both server-side (routing) and client-side (client generation).
 */
export const METADATA_KEYS = {
    API_PATH: 'webpieces:api-path',
    ENDPOINTS: 'webpieces:endpoints',
    AUTH_META: 'webpieces:auth-meta',
    /** 'rpc' (default, sync request/response) vs 'pubsub' (fire-and-forget cloud task). */
    API_KIND: 'webpieces:api-kind',
    /** Per-method Cloud Tasks queue-name override (set via @Queue). */
    QUEUE_OVERRIDE: 'webpieces:queue-override',
};

/**
 * Route metadata stored per-method at runtime.
 * Used internally by http-routing and http-client as the runtime representation
 * of a route. Constructed from @ApiPath + @Endpoint metadata by createApiClient
 * and ApiRoutingFactory.
 */
export class RouteMetadata {
    httpMethod: string;
    path: string;
    methodName: string;
    controllerClassName?: string;
    authMeta?: AuthMeta;

    constructor(
        httpMethod: string,
        path: string,
        methodName: string,
        controllerClassName?: string,
        authMeta?: AuthMeta,
    ) {
        this.httpMethod = httpMethod;
        this.path = path;
        this.methodName = methodName;
        this.controllerClassName = controllerClassName;
        this.authMeta = authMeta;
    }
}

/**
 * The service-to-service / user auth mode of an endpoint. Discriminated union so
 * a filter can `switch (mode.kind)` and get the data it needs, exhaustively.
 *
 * - `public`        → no auth check
 * - `jwt`           → user-facing JWT (optionally role-gated), validated by the app AuthFilter
 * - `oidc`          → Google OIDC service-to-service (Cloud Tasks delivery / cross-service RPC);
 *                     `callers` is the allow-list of caller service accounts ('self' = this service's SA)
 * - `shared-secret` → constant-time compare of a header against `process.env[secretEnv]`
 */
export type AuthMode =
    | { kind: 'public' }
    | { kind: 'jwt'; roles: string[] }
    | { kind: 'oidc'; callers: string[] }
    | { kind: 'shared-secret'; secretEnv: string };

/**
 * Auth metadata attached to a class or method via one of the auth decorators
 * (@Public / @AuthJwt / @AuthOidc / @AuthSharedSecret) or the legacy @Authentication.
 *
 * Carries a discriminated {@link AuthMode}. The `authenticated`/`roles` getters are
 * kept for back-compat with readers that only understand the user-JWT model
 * (e.g. the example AuthFilter).
 */
export class AuthMeta {
    mode: AuthMode;

    constructor(mode: AuthMode) {
        this.mode = mode;
    }

    /** True for every non-public mode (jwt, oidc, shared-secret). */
    get authenticated(): boolean {
        return this.mode.kind !== 'public';
    }

    /** JWT roles, or empty for non-jwt modes. */
    get roles(): string[] {
        return this.mode.kind === 'jwt' ? this.mode.roles : [];
    }
}

/**
 * @ApiPath(basePath) - Class decorator that marks a class as an API definition
 * and sets the base path for all endpoints.
 *
 * Usage:
 * ```typescript
 * @Authentication({authenticated: true})
 * @ApiPath('/api/save')
 * abstract class SaveApi {
 *   @Endpoint('/item')
 *   save(request: SaveRequest): Promise<SaveResponse> { ... }
 * }
 * ```
 */
export function ApiPath(basePath: string): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_PATH, basePath, target);

        // Initialize endpoints map if not exists
        if (!Reflect.hasMetadata(METADATA_KEYS.ENDPOINTS, target)) {
            Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, {}, target);
        }
    };
}

/**
 * @Endpoint(path) - Method decorator that registers a POST endpoint at the given path.
 *
 * All endpoints are POST-only (matching gRPC/thrift style).
 *
 * Usage:
 * ```typescript
 * @Endpoint('/item')
 * save(request: SaveRequest): Promise<SaveResponse> { ... }
 * ```
 */
export function Endpoint(path: string): MethodDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;

        const endpoints: Record<string, string> =
            Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, metadataTarget) || {};

        endpoints[propertyKey as string] = path;

        Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, endpoints, metadataTarget);
    };
}

/**
 * Authentication config passed to @Authentication() decorator.
 */
export class AuthenticationConfig {
    authenticated: boolean;
    roles?: string[];

    constructor(authenticated: boolean, roles?: string[]) {
        this.authenticated = authenticated;
        this.roles = roles;
    }
}

/**
 * @Authentication(config) - Class or method decorator for auth requirements.
 *
 * Single decorator replaces @Public/@Authenticated/@Roles:
 * - @Authentication({authenticated: false}) → public, no auth check
 * - @Authentication({authenticated: true}) → requires authentication
 * - @Authentication({authenticated: true, roles: ['admin']}) → requires auth + roles
 *
 * Class-level is required. Methods can override class-level.
 * Throws if authenticated=false but roles are specified (contradictory).
 */
export function Authentication(config: AuthenticationConfig): ClassDecorator & MethodDecorator {
    // Validate: can't be public with roles
    if (!config.authenticated && config.roles && config.roles.length > 0) {
        throw new Error(
            `Invalid @Authentication config: authenticated=false but roles=${JSON.stringify(config.roles)}. ` +
            `Cannot require roles on a public endpoint. Set authenticated=true or remove roles.`
        );
    }

    const mode: AuthMode = config.authenticated
        ? { kind: 'jwt', roles: config.roles ?? [] }
        : { kind: 'public' };
    return defineAuthMode(mode);
}

/**
 * Shared implementation for every auth decorator: stores an {@link AuthMeta} for
 * the given {@link AuthMode} at class- or method-level, rejecting a second auth
 * decorator on the same target.
 */
function defineAuthMode(mode: AuthMode): ClassDecorator & MethodDecorator {
    const authMeta = new AuthMeta(mode);

    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey?: string | symbol, _descriptor?: PropertyDescriptor) => {
        if (propertyKey !== undefined) {
            // Method decorator
            const metadataTarget = typeof target === 'function' ? target : target.constructor;
            validateNoConflictingDecorators(metadataTarget, propertyKey as string);
            Reflect.defineMetadata(METADATA_KEYS.AUTH_META, authMeta, metadataTarget, propertyKey);
        } else {
            // Class decorator
            validateNoConflictingDecorators(target, undefined);
            Reflect.defineMetadata(METADATA_KEYS.AUTH_META, authMeta, target);
        }
    };
}

/**
 * @Public() - endpoint requires no authentication. Class- or method-level.
 */
export function Public(): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'public' });
}

/**
 * @AuthJwt(...roles) - user-facing JWT auth, optionally role-gated. The app-level
 * AuthFilter validates the token; roles=[] means "any authenticated user".
 */
export function AuthJwt(...roles: string[]): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'jwt', roles });
}

/**
 * @AuthOidc(...callers) - Google OIDC service-to-service auth (Cloud Tasks delivery
 * / cross-service RPC). `callers` is the allow-list of caller service accounts;
 * defaults to ['self'] (only this service's own runtime SA, e.g. self-enqueue).
 */
export function AuthOidc(...callers: string[]): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'oidc', callers: callers.length > 0 ? callers : ['self'] });
}

/**
 * @AuthSharedSecret(envVarName) - constant-time compare of an inbound header against
 * process.env[envVarName]. For internal callers that cannot mint OIDC tokens.
 */
export function AuthSharedSecret(envVarName: string): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'shared-secret', secretEnv: envVarName });
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
 * Check if a class has @ApiPath decorator.
 */
export function isApiPath(apiClass: Function): boolean {
    return Reflect.hasMetadata(METADATA_KEYS.API_PATH, apiClass);
}

/**
 * Get auth metadata for a specific method, falling back to class-level auth.
 * Method-level auth takes precedence over class-level auth.
 */
export function getAuthMeta(apiClass: Function, methodName?: string): AuthMeta | undefined {
    // Check method-level first
    if (methodName) {
        const methodAuth = Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName);
        if (methodAuth) {
            return methodAuth;
        }
    }

    // Fall back to class-level
    return Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);
}

/**
 * Get the auth mode for a method (falling back to class-level), or undefined.
 * Convenience wrapper over getAuthMeta for callers that only want the mode.
 */
export function getAuthMode(apiClass: Function, methodName?: string): AuthMode | undefined {
    return getAuthMeta(apiClass, methodName)?.mode;
}

/**
 * Fail-fast at wiring time if any endpoint lacks an auth mode. Both the server
 * (ApiRoutingFactory) and the task/rpc clients call this so a missing auth
 * decorator is a startup error, never a silent open endpoint.
 * @throws Error naming the first endpoint with no @Authentication/@Public/@Auth* decorator.
 */
export function assertEveryEndpointHasAuthMode(apiClass: Function): void {
    const apiName = apiClass.name || 'Unknown';
    const endpoints = getEndpoints(apiClass) || {};
    for (const methodName of Object.keys(endpoints)) {
        if (!getAuthMeta(apiClass, methodName)) {
            throw new Error(
                `Endpoint '${methodName}' in ${apiName} has no auth decorator. ` +
                `Add @Public(), @AuthJwt(...), @AuthOidc(...) or @AuthSharedSecret(...) ` +
                `to the class or method.`,
            );
        }
    }
}

// ============================================================
// API kind (RPC vs PubSub/Cloud Tasks) + queue naming
// ============================================================

/**
 * API kind. 'rpc' = synchronous request/response (http-client ↔ ApiRoutingFactory).
 * 'pubsub' = fire-and-forget cloud task; the enqueue client (cloudtasks-client)
 * schedules a Cloud Task that is later delivered to the SAME controller endpoint.
 */
export type ApiKind = 'rpc' | 'pubsub';

/**
 * @Rpc() - marks an API class as synchronous request/response (the default kind).
 * Present mostly for symmetry/readability; an undecorated API is treated as 'rpc'.
 */
export function Rpc(): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_KIND, 'rpc' as ApiKind, target);
    };
}

/**
 * @PubSub() - marks an API class as fire-and-forget over Cloud Tasks. Every method
 * MUST return Promise<void> (a compile-time contract on the abstract API). The
 * enqueue client and the controller share this one class, exactly like RPC.
 */
export function PubSub(): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_KIND, 'pubsub' as ApiKind, target);
    };
}

/**
 * @Queue(name) - override the Cloud Tasks queue name for a @PubSub method. Default
 * (no decorator) is `${ApiClassName}-${methodName}`, matched 1:1 by Terraform.
 */
export function Queue(name: string): MethodDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const overrides: Record<string, string> =
            Reflect.getMetadata(METADATA_KEYS.QUEUE_OVERRIDE, metadataTarget) || {};
        overrides[propertyKey as string] = name;
        Reflect.defineMetadata(METADATA_KEYS.QUEUE_OVERRIDE, overrides, metadataTarget);
    };
}

/**
 * Get the API kind. Defaults to 'rpc' when neither @Rpc nor @PubSub is present.
 */
export function getApiKind(apiClass: Function): ApiKind {
    return (Reflect.getMetadata(METADATA_KEYS.API_KIND, apiClass) as ApiKind) ?? 'rpc';
}

/**
 * Assert the API class is of the expected kind (used by the clients: the RPC
 * client rejects a @PubSub api and vice-versa).
 * @throws Error if the kind doesn't match.
 */
export function assertApiKind(apiClass: Function, expected: ApiKind): void {
    const actual = getApiKind(apiClass);
    if (actual !== expected) {
        const apiName = apiClass.name || 'Unknown';
        throw new Error(
            `API ${apiName} is @${actual === 'pubsub' ? 'PubSub' : 'Rpc'} but a ` +
            `${expected === 'pubsub' ? '@PubSub (cloud task)' : '@Rpc'} API was required here.`,
        );
    }
}

/**
 * Validate @PubSub conventions at wiring time: the class must be @ApiPath + @PubSub
 * and declare at least one endpoint. (Return-type is Promise<void>, a compile-time
 * contract — TS erases types at runtime so it cannot be re-checked here.)
 * @throws Error if conventions are violated.
 */
export function assertPubSubConventions(apiClass: Function): void {
    assertApiKind(apiClass, 'pubsub');
    const apiName = apiClass.name || 'Unknown';
    if (!isApiPath(apiClass)) {
        throw new Error(`@PubSub API ${apiName} must also be decorated with @ApiPath()`);
    }
    const endpoints = getEndpoints(apiClass) || {};
    if (Object.keys(endpoints).length === 0) {
        throw new Error(`@PubSub API ${apiName} declares no @Endpoint methods`);
    }
}

/**
 * Resolve the Cloud Tasks queue name for a @PubSub method: the @Queue override if
 * present, else `${ApiClassName}-${methodName}`.
 */
export function getQueueName(apiClass: Function, methodName: string): string {
    const overrides: Record<string, string> =
        Reflect.getMetadata(METADATA_KEYS.QUEUE_OVERRIDE, apiClass) || {};
    return overrides[methodName] ?? `${apiClass.name || 'Unknown'}-${methodName}`;
}

/**
 * Validate that a class/method doesn't have conflicting auth decorators.
 * @throws Error if multiple @Authentication decorators are found on the same target.
 */
export function validateNoConflictingDecorators(apiClass: Function, methodName: string | undefined): void {
    const existing = methodName
        ? Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName)
        : Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);

    if (existing) {
        const targetName = apiClass.name || 'Unknown';
        const location = methodName ? `method '${methodName}' of ${targetName}` : `class ${targetName}`;
        throw new Error(
            `Conflicting @Authentication on ${location}. ` +
            `Only one @Authentication() decorator allowed per target.`
        );
    }
}
