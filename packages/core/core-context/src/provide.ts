import 'reflect-metadata';
import { provide } from '@inversifyjs/binding-decorators';
import type { BindInWhenOnFluentSyntax, ServiceIdentifier } from 'inversify';

/**
 * DI provider decorators (the lightweight DI seam shared across webpieces).
 *
 * These live in @webpieces/core-context — the lowest package that already owns
 * request-scoped context — so libraries (cloudtasks-client, http-client, …) can
 * register singletons WITHOUT depending on the server-side @webpieces/http-routing
 * package. http-routing re-exports them for back-compat.
 */

/**
 * Provides a singleton-scoped dependency.
 * When called without arguments, the decorated class binds to itself.
 *
 * Usage:
 * ```typescript
 * @provideSingleton()
 * export class SaveController {
 *   // ...
 * }
 * ```
 */
export function provideSingleton(): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        return provide(target, (bind: BindInWhenOnFluentSyntax<unknown>) => bind.inSingletonScope())(target);
    };
}

/**
 * Provides a singleton-scoped dependency bound to a specific token (Symbol or abstract class).
 * Use this in libraries/apis-external/** to bind an impl to the Symbol defined in libraries/apis/**.
 *
 * Usage:
 * ```typescript
 * import { SOME_API_TOKEN } from '@myorg/some-api';
 *
 * @provideSingletonAs(SOME_API_TOKEN)
 * export class SomeApiImpl { ... }
 * ```
 */
export function provideSingletonAs<T>(serviceIdentifier: ServiceIdentifier<T>): ClassDecorator {
    return provide(serviceIdentifier, (bind: BindInWhenOnFluentSyntax<T>) => bind.inSingletonScope());
}

/**
 * Provides a transient-scoped dependency (new instance every time).
 * When called without arguments, the decorated class binds to itself.
 *
 * Usage:
 * ```typescript
 * @provideTransient()
 * export class TransientController {
 *   // ...
 * }
 * ```
 */
export function provideTransient(): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        return provide(target)(target);
    };
}
