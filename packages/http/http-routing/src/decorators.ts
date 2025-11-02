import 'reflect-metadata';
import { fluentProvide, provide } from 'inversify-binding-decorators';

/**
 * Metadata keys for server-side routing.
 * These are specific to the routing package (server-side only).
 */
export const ROUTING_METADATA_KEYS = {
  CONTROLLER: 'webpieces:controller',
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
    return fluentProvide(target).inSingletonScope().done()(target);
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
