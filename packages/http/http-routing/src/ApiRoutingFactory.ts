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
 *     new ApiRoutingFactory(SaveApiPrototype, SaveController),
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

        // Validate that controllerClass implements the methods from apiMetaClass
        this.validateControllerImplementsApi();
    }

    /**
     * Validate that the controller implements all endpoint methods from the API.
     */
    private validateControllerImplementsApi(): void {
        const endpoints = getEndpoints(this.apiMetaClass) || {};

        for (const methodName of Object.keys(endpoints)) {
            const controllerPrototype = this.controllerClass.prototype;

            if (typeof controllerPrototype[methodName] !== 'function') {
                const controllerName = this.controllerClass.name || 'Unknown';
                const apiName = this.apiMetaClass.name || 'Unknown';
                throw new Error(
                    `Controller ${controllerName} must implement method ${methodName} from API ${apiName}`,
                );
            }
        }
    }

    /**
     * Configure routes by reading @ApiPath + @Endpoint metadata.
     */
    configure(routeBuilder: RouteBuilder): void {
        const basePath = getApiPath(this.apiMetaClass)!;
        const endpoints = getEndpoints(this.apiMetaClass) || {};
        const controllerFilepath = this.getControllerFilepath();

        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            const fullPath = basePath + endpointPath;

            const routeMeta = new RouteMetadata(
                'POST',
                fullPath,
                methodName,
                this.controllerClass.name,
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
