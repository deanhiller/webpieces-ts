import { Routes, RouteBuilder, RouteDefinition } from './WebAppMeta';
import { isApiPath, getApiPath, getEndpoints, getAuthMeta, isFormPost, getMaskSpec, LogManager, RouteMetadata, AuthMeta, MISSING_AUTH_DECORATOR_FIX, RuntimeLocality } from '@webpieces/core-util';
import 'reflect-metadata';
import { ROUTING_METADATA_KEYS } from './decorators';

const log = LogManager.getLogger('ApiRoutingFactory');

/**
 * Type representing a class constructor (abstract or concrete).
 */
// webpieces-disable no-any-unknown -- generic type alias requires unconstrained default
export type ClassType<T = unknown> = Function & { prototype: T };

/**
 * ApiRoutingFactory - Automatically wire API interfaces to controllers.
 * Reads @ApiPath/@Endpoint decorators from an API prototype class and
 * registers POST routes for each endpoint.
 *
 * Replaces the old RESTApiRoutes class.
 *
 * Usage:
 * ```typescript
 * // In your ServerMeta:
 * getRoutes(): Routes[] {
 *   return [
 *     new ApiRoutingFactory(SaveApi, SaveController),
 *   ];
 * }
 * ```
 */
// webpieces-disable no-any-unknown -- generic class requires unconstrained default type params
export class ApiRoutingFactory<TApi = unknown, TController extends TApi = TApi> implements Routes {
    private apiMetaClass: ClassType<TApi>;
    private controllerClass: ClassType<TController>;

    /**
     * @param apiMetaClass - The API prototype class with @ApiPath/@Endpoint decorators
     * @param controllerClass - The controller class that implements the API
     */
    constructor(apiMetaClass: ClassType<TApi>, controllerClass: ClassType<TController>) {
        this.apiMetaClass = apiMetaClass;
        this.controllerClass = controllerClass;

        // Validate that apiMetaClass is marked with @ApiPath
        if (!isApiPath(apiMetaClass)) {
            const className = apiMetaClass.name || 'Unknown';
            throw new Error(`Class ${className} must be decorated with @ApiPath()`);
        }

        // Validate that controllerClass actually extends apiMetaClass.
        // TypeScript's structural typing won't catch a missing `extends` here, so we check
        // the runtime prototype chain. Without this, a controller can silently drift from
        // the API contract (wrong method names, wrong signatures) and only fail later as a
        // confusing routing or method-not-found error.
        const apiName = apiMetaClass.name || 'Unknown';
        const controllerName = controllerClass.name || 'Unknown';
        if (!(apiMetaClass.prototype as object).isPrototypeOf(controllerClass.prototype as object)) {
            throw new Error(
                `Controller ${controllerName} must extend ${apiName}. ` +
                `Change the class declaration to: ` +
                `'export class ${controllerName} extends ${apiName} { ... }'`,
            );
        }

    }

    /**
     * Configure routes by reading @ApiPath + @Endpoint metadata.
     * Validates controller methods and auth decorators in single loop.
     */
    configure(routeBuilder: RouteBuilder): void {
        const basePath = getApiPath(this.apiMetaClass)!;
        const endpoints = getEndpoints(this.apiMetaClass) || {};
        const controllerFilepath = this.getControllerFilepath();
        const apiName = this.apiMetaClass.name || 'Unknown';
        const controllerName = this.controllerClass.name || 'Unknown';

        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            // Validate controller implements this method
            if (typeof this.controllerClass.prototype[methodName] !== 'function') {
                throw new Error(
                    `Controller ${controllerName} must implement method ${methodName} from API ${apiName}`,
                );
            }

            // Validate auth decorator exists (class-level or method-level)
            const authMeta = getAuthMeta(this.apiMetaClass, methodName);
            if (!authMeta) {
                throw new Error(
                    `Endpoint '${methodName}' in ${apiName} has no auth decorator. ` +
                    MISSING_AUTH_DECORATOR_FIX,
                );
            }

            // @AuthLocalOnly: off-local the route is never registered, so the endpoint does not
            // exist rather than existing-and-refusing. This is the PRIMARY gate; AuthFilter's 404 is
            // the backstop for routes added by hand through RouteBuilder. One decorator drives both
            // — the point of moving this into the framework was that apps were hand-syncing exactly
            // these two halves across two files with a comment.
            if (authMeta.mode.kind === 'local-only' && !RuntimeLocality.isLocalDevelopment()) {
                log.info(
                    `Skipping @AuthLocalOnly endpoint ${apiName}.${methodName} — this process is not ` +
                    `a local developer machine, so the route is not registered at all.`,
                );
                continue;
            }

            const fullPath = basePath + endpointPath;
            const routeMeta = new RouteMetadata(
                'POST',
                fullPath,
                methodName,
                controllerName,
                authMeta,
                apiName,
                isFormPost(this.apiMetaClass, methodName),
                getMaskSpec(this.apiMetaClass, methodName),
            );

            routeBuilder.addRoute(
                new RouteDefinition(routeMeta, this.controllerClass, controllerFilepath, this.apiMetaClass),
            );
        }
    }

    /**
     * Get the filepath of the controller source file.
     * Uses a heuristic based on the controller class name.
     */
    private getControllerFilepath(): string | undefined {
        // Check for explicit @SourceFile decorator metadata
        const filepath = Reflect.getMetadata(
            ROUTING_METADATA_KEYS.SOURCE_FILEPATH,
            this.controllerClass,
        );
        if (filepath) {
            return filepath;
        }

        // Fallback to class name pattern
        const className = this.controllerClass.name;
        return className ? `**/${className}.ts` : undefined;
    }

    /**
     * Get auth metadata for a specific method, falling back to class-level.
     */
    getAuthMetaForMethod(methodName: string): AuthMeta | undefined {
        return getAuthMeta(this.apiMetaClass, methodName);
    }

    /**
     * Get the API interface class.
     */
    getApiClass(): ClassType<TApi> {
        return this.apiMetaClass;
    }

    /**
     * Get the controller class.
     */
    getControllerClass(): ClassType<TController> {
        return this.controllerClass;
    }
}
