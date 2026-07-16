import 'reflect-metadata';
import { provide } from '@inversifyjs/binding-decorators';
import { injectable } from 'inversify';
import type { BindInWhenOnFluentSyntax, ServiceIdentifier } from 'inversify';

/**
 * DI provider decorators (the lightweight DI seam shared across webpieces).
 *
 * These live in @webpieces/core-context — the lowest package that already owns
 * request-scoped context — so libraries (cloudtasks-client, http-client, …) can
 * register bindings WITHOUT depending on the server-side @webpieces/http-routing package.
 *
 * A plain concrete singleton no longer needs a decorator here: annotate it
 * `@injectable(bindingScopeValues.Singleton)` (from `inversify`) and let the app container's
 * autobind self-bind it on first resolve (inject-by-type). The decorators BELOW cover the two
 * cases autobind cannot: binding an interface/Symbol TOKEN to a default impl, and the
 * framework-registry variants (see frameworkProvide.ts).
 */

/**
 * Marks this class as the DEFAULT (overridable) singleton implementation OF a contract token
 * (a Symbol or an abstract class). Binds `token -> thisClass` as a singleton. Guice's
 * `@ImplementedBy`, done impl-side so the api never imports the impl (no cycle).
 *
 * An app overrides the default via appOverrides, same idiom as AuthConfig:
 * `(await options.rebind(TOKEN)).to(OtherImpl)`.
 *
 * The DI-graph designer reads this in pass 1, so `@inject(TOKEN)` renders as `TOKEN (thisClass)`
 * and expands this class's own dependencies instead of dead-ending as unresolved.
 *
 * Usage:
 * ```typescript
 * import { SOME_API_TOKEN } from '@myorg/some-api';
 *
 * @provideSingletonDefaultForApi(SOME_API_TOKEN)
 * export class SomeApiImpl { ... }
 * ```
 */
// webpieces-disable no-function-outside-class -- a decorator factory cannot be a class method
export function provideSingletonDefaultForApi<T>(serviceIdentifier: ServiceIdentifier<T>): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        // Mark @injectable so the impl's ctor design:paramtypes are read when bound via .to(target).
        injectable()(target);
        return provide(serviceIdentifier, (bind: BindInWhenOnFluentSyntax<T>) => bind.inSingletonScope())(target);
    };
}

/**
 * Provider<T> — Guice's object-oriented `Provider<T>`, which inversify does not have.
 *
 * Inversify's own `Provider<T>` is a FUNCTION type `(...args) => Promise<T>` and its
 * `toProvider()` binding is deprecated ("Providers will be removed in v8"), so we model
 * Guice's seam ourselves.
 *
 * It caches NOTHING, because `ResolutionContext.get()` already applies the BOUND SCOPE of `T`:
 *
 *   T bound @provideFrameworkSingleton -> every get() returns the SAME instance, built on the
 *                                        first call. That is a LAZY SINGLETON.
 *   T bound @provideFrameworkTransient -> every get() builds a NEW instance. That is 1-to-many.
 *
 * A provider that cached internally would break the transient case outright: the second get()
 * would hand back the first instance.
 *
 * `get()` is SYNCHRONOUS, like Guice's. An async `get()` would force every consumer (e.g.
 * `ClientHttpFactory.createRpcClient`) to become async, and neither Angular's `useFactory` nor
 * inversify's `toDynamicValue` can await.
 *
 * TypeScript erases generics, so `Provider<T>` has NO runtime identity and cannot itself be a DI
 * token. Register it against a Symbol naming T, with {@link bindFrameworkProvider}, and inject it
 * by that token — the declared type is what a reader needs, the Symbol is what inversify needs:
 *
 * ```typescript
 * // webpieces-disable no-symbol-di-tokens -- Provider<T> is erased at runtime; T names the token
 * export const TASK_PROXY_PROVIDER = Symbol.for('TaskProxyClientProvider');
 * bindFrameworkProvider(TASK_PROXY_PROVIDER, TaskProxyClient);
 *
 * constructor(@inject(TASK_PROXY_PROVIDER) private readonly provider: Provider<TaskProxyClient>) {}
 * ```
 *
 * Inject a Provider when you need a dependency LATER or REPEATEDLY rather than at construction
 * time — a lazily-created singleton, or a fresh instance per call.
 */
export class Provider<T> {
    constructor(private readonly resolve: () => T) {}

    get(): T {
        return this.resolve();
    }
}
