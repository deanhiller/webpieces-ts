import 'reflect-metadata';
import { provide } from '@inversifyjs/binding-decorators';

/**
 * Metadata keys for server-side routing.
 * These are specific to the routing package (server-side only).
 */
export const ROUTING_METADATA_KEYS = {
  CONTROLLER: 'webpieces:controller',
  SOURCE_FILEPATH: 'webpieces:source-filepath',
};

/**
 * @Controller decorator to mark a class as a controller.
 * This is a server-side only decorator.
 *
 * Usage:
 * ```typescript
 * @Controller()
 * export class SaveController implements SaveApi {
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
 * SourceFile decorator to explicitly set the source filepath for a controller.
 * This is used by filter matching to determine which filters apply to the controller.
 *
 * If not specified, the system will use a heuristic based on class name.
 *
 * Usage:
 * @SourceFile('src/controllers/admin/UserController.ts')
 * @Controller()
 * export class UserController implements UserApi
 *
 * @param filepath - The source filepath of the controller
 */
export function SourceFile(filepath: string): ClassDecorator {
  return (target: any) => {
    Reflect.defineMetadata(
      ROUTING_METADATA_KEYS.SOURCE_FILEPATH,
      filepath,
      target
    );
  };
}

/**
 * Provides a singleton-scoped dependency.
 * When called without arguments, the decorated class binds to itself.
 *
 * Server-side only - registers classes in the DI container.
 *
 * Usage:
 * ```typescript
 * @provideSingleton()
 * @Controller()
 * export class SaveController {
 *   // ...
 * }
 * ```
 */
export function provideSingleton() {
  return (target: any) => {
    return provide(target, (bind) => bind.inSingletonScope())(target);
  };
}

/**
 * Provides a transient-scoped dependency (new instance every time).
 * When called without arguments, the decorated class binds to itself.
 *
 * Server-side only - registers classes in the DI container.
 *
 * Usage:
 * ```typescript
 * @provideTransient()
 * @Controller()
 * export class TransientController {
 *   // ...
 * }
 * ```
 */
export function provideTransient() {
  return (target: any) => {
    return provide(target)(target);
  };
}
