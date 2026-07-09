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
        // Call inTransientScope() EXPLICITLY. Omitting the scope call inherits the container's
        // defaultScope which, while Transient by default in inversify 7, would silently flip
        // meaning if anyone ever passed `new Container({ defaultScope: ... })`.
        // webpieces-disable no-any-unknown -- inversify's own fluent-syntax generic for a self-binding
        return provide(target, (bind: BindInWhenOnFluentSyntax<unknown>) => bind.inTransientScope())(target);
    };
}

/**
 * Provider<T> — Guice's object-oriented `Provider<T>`, which inversify does not have.
 *
 * Inversify's own `Provider<T>` is a FUNCTION type `(...args) => Promise<T>` and its
 * `toProvider()` binding is deprecated ("Providers will be removed in v8"), so we model
 * Guice's seam ourselves.
 *
 * `get()` is SYNCHRONOUS, like Guice's. An async `get()` would force every consumer
 * (e.g. `ClientHttpFactory.createClient`) to become async, and neither Angular's
 * `useFactory` nor inversify's `toDynamicValue` can await.
 *
 * Inject a Provider when you need a dependency LATER or REPEATEDLY rather than at
 * construction time — a lazily-created singleton, or a fresh instance per call.
 */
export abstract class Provider<T> {
    abstract get(): T;
}

/**
 * The container-backed {@link Provider}. It deliberately caches NOTHING, because
 * `ResolutionContext.get()` already applies the BOUND SCOPE of `T`:
 *
 *   T bound with @provideSingleton -> every get() returns the SAME instance, constructed on
 *                                    the first call. That is a LAZY SINGLETON.
 *   T bound transient             -> every get() constructs a NEW instance. That is 1-to-many.
 *
 * A provider that cached internally would break the transient case outright: the second
 * get() would hand back the first instance.
 *
 * Subclass it once per `T` so the subclass IS the DI token (no Symbol tokens), then register
 * the pair with {@link bindFrameworkProvider}:
 * ```typescript
 * export class ProxyClientProvider extends ContainerProvider<NodeProxyClient> {}
 * ```
 */
export class ContainerProvider<T> extends Provider<T> {
    constructor(private readonly resolve: () => T) {
        super();
    }

    get(): T {
        return this.resolve();
    }
}
