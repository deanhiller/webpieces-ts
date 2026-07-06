import 'reflect-metadata';

/**
 * Metadata keys for server-side routing.
 * These are specific to the routing package (server-side only).
 */
export const ROUTING_METADATA_KEYS = {
    CONTROLLER: 'webpieces:controller',
    NOT_CONTROLLER: 'webpieces:not-controller',
    API_IMPLEMENTATION: 'webpieces:api-implementation',
    SOURCE_FILEPATH: 'webpieces:source-filepath',
};

/**
 * @Controller decorator — marks a controller (server-side only).
 *
 * Usage:
 * ```typescript
 * @Controller()
 * export class SaveController {
 *   // ...
 * }
 * ```
 */
export function Controller(): ClassDecorator {
    return (target: any) => {
        Reflect.defineMetadata(ROUTING_METADATA_KEYS.CONTROLLER, true, target);
    };
}

/**
 * Helper function to check if a class is a controller.
 * Server-side only.
 */
export function isController(controllerClass: any): boolean {
    return Reflect.getMetadata(ROUTING_METADATA_KEYS.CONTROLLER, controllerClass) === true;
}

/**
 * @NotController decorator — explicitly marks a class that implements/extends an `*Api` contract
 * as deliberately NOT a controller (e.g. a simulator, an in-process client, a test double).
 *
 * The `enforce-controller-naming` rule requires every class whose heritage ends in `*Api` to declare
 * its intent: either `@Controller` (then it must be named `{Something}Controller` and live in a
 * `{something}-controller.ts` file) OR `@NotController` (then it is exempt from those naming rules).
 * This is a pure marker — it registers no route and only records intent for the lint rule.
 *
 * Usage:
 * ```typescript
 * @NotController()
 * export class Server2Simulator { ... }
 * ```
 */
export function NotController(): ClassDecorator {
    return (target: object) => {
        Reflect.defineMetadata(ROUTING_METADATA_KEYS.NOT_CONTROLLER, true, target);
    };
}

/**
 * Helper function to check if a class is explicitly marked as NOT a controller.
 * Server-side only.
 */
export function isNotController(controllerClass: object): boolean {
    return Reflect.getMetadata(ROUTING_METADATA_KEYS.NOT_CONTROLLER, controllerClass) === true;
}

/**
 * @ApiImplementation decorator — marks the top-of-DAG implementation class in a LIBRARY
 * (a `role:designed-lib` project) whose DI design should be generated.
 *
 * It is the library-side analog of `@Controller`: where a server's design roots on its
 * `@Controller` classes, a designed-lib's design roots on its `@ApiImplementation` classes.
 * A `role:designed-lib` project is REQUIRED to have at least one such class — otherwise the
 * DI-graph generator has no root and fails.
 *
 * Put it on the top implementation class a library exports and binds in its `ContainerModule`
 * (e.g. the class an app injects to drive the library). Like `@Controller`, this is a pure
 * marker read by the static DI-graph analyzer (by decorator name); it registers nothing at
 * runtime on its own.
 *
 * Usage:
 * ```typescript
 * @ApiImplementation()
 * @injectable()
 * export class AgentHandler { ... }
 * ```
 */
export function ApiImplementation(): ClassDecorator {
    return (target: object) => {
        Reflect.defineMetadata(ROUTING_METADATA_KEYS.API_IMPLEMENTATION, true, target);
    };
}

/**
 * Helper function to check if a class is marked as an API implementation (designed-lib root).
 * Server/library side only.
 */
export function isApiImplementation(implClass: object): boolean {
    return Reflect.getMetadata(ROUTING_METADATA_KEYS.API_IMPLEMENTATION, implClass) === true;
}

/**
 * SourceFile decorator to explicitly set the source filepath for a controller.
 * This is used by filter matching to determine which filters apply to the controller.
 *
 * If not specified, the system will use a heuristic based on the controller's name.
 *
 * Usage:
 * @SourceFile('src/controllers/admin/UserController.ts')
 * @Controller()
 * export class UserController { ... }
 *
 * @param filepath - The source filepath of the controller
 */
export function SourceFile(filepath: string): ClassDecorator {
    return (target: any) => {
        Reflect.defineMetadata(ROUTING_METADATA_KEYS.SOURCE_FILEPATH, filepath, target);
    };
}

// NOTE: provideSingleton / provideSingletonAs / provideTransient moved to
// @webpieces/core-context (the shared DI seam). http-routing re-exports them
// from there in index.ts for back-compat.
