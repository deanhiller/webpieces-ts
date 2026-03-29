import { Routes, RouteBuilder, RouteDefinition } from './WebAppMeta';
import { isApiPath, getApiPath, getEndpoints, getAuthMeta, RouteMetadata, AuthMeta } from '@webpieces/http-api';
import 'reflect-metadata';
import { ROUTING_METADATA_KEYS } from './decorators';

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
                    `Endpoint '${methodName}' in ${apiName} has no @Authentication decorator. ` +
                    `Add @Authentication(new AuthenticationConfig(...)) to the class or method.`,
                );
            }

            const fullPath = basePath + endpointPath;
            const routeMeta = new RouteMetadata(
                'POST',
                fullPath,
                methodName,
                controllerName,
                authMeta,
            );

            routeBuilder.addRoute(new RouteDefinition(routeMeta, this.controllerClass, controllerFilepath));
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
