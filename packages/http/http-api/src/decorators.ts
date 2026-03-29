import 'reflect-metadata';

/**
 * Metadata keys for storing API routing information.
 * These keys are used by both server-side (routing) and client-side (client generation).
 */
export const METADATA_KEYS = {
    API_PATH: 'webpieces:api-path',
    ENDPOINTS: 'webpieces:endpoints',
    AUTH_META: 'webpieces:auth-meta',
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
 * Auth metadata attached to a class or method via @Authentication().
 *
 * - authenticated=false → public endpoint (no auth check)
 * - authenticated=true, no roles → requires authentication
 * - authenticated=true, roles=['admin'] → requires authentication + specific roles
 * - authenticated=false + roles → INVALID (caught at decorator time)
 */
export class AuthMeta {
    authenticated: boolean;
    roles: string[];

    constructor(authenticated: boolean, roles?: string[]) {
        this.authenticated = authenticated;
        this.roles = roles ?? [];
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

    const authMeta = new AuthMeta(config.authenticated, config.roles);

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
