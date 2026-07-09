import { ContainerModule } from 'inversify';
import type { ContainerModuleLoadOptions, ResolutionContext, ServiceIdentifier } from 'inversify';
import { Provider } from './provide';

/**
 * Framework-only DI provider decorators — a SEPARATE registry from the client-facing
 * @provideSingleton (which uses @inversifyjs/binding-decorators' single global registry).
 *
 * WHY: binding-decorators registers every @provideSingleton class under ONE global
 * reflect-metadata key, and buildProviderModule() scoops up that whole key. If webpieces
 * framework classes (RouteBuilderImpl, the filters, WebpiecesRouter) used @provideSingleton,
 * a CLIENT app's buildProviderModule() would drag those framework internals into its own
 * container. To keep the two worlds separate:
 *   - packages/** (framework libs) MUST use provideFrameworkSingleton (this registry),
 *     enforced by the no-global-providesingleton-in-packages ESLint rule.
 *   - apps/** (and downstream client projects) use plain @provideSingleton (the global one).
 * The router loads BOTH buildFrameworkModule() and buildProviderModule(), so everything
 * resolves — but a client's buildProviderModule() only ever sees the client's own classes.
 */

// webpieces-disable no-any-unknown -- decorator targets are arbitrary class constructors
type AnyCtor = new (...args: any[]) => unknown;

/** How a framework binding is scoped. Always explicit — never inherited from the container. */
export type FrameworkScope = 'singleton' | 'transient';

class FrameworkBinding {
    constructor(
        public readonly serviceIdentifier: ServiceIdentifier,
        public readonly target: AnyCtor,
        public readonly scope: FrameworkScope = 'singleton',
    ) {}
}

/** A Provider token paired with the class its get() resolves. See {@link bindFrameworkProvider}. */
class FrameworkProviderBinding {
    constructor(
        public readonly token: ServiceIdentifier,
        public readonly target: AnyCtor,
    ) {}
}

/** The webpieces-only binding registry (a plain module-level list, one per hosted core-context). */
const frameworkRegistry: FrameworkBinding[] = [];

/** Provider<T> bindings, applied after frameworkRegistry so their targets are already bound. */
const frameworkProviderRegistry: FrameworkProviderBinding[] = [];

/**
 * Framework equivalent of @provideSingleton: registers the class as a singleton bound to
 * itself, into the webpieces framework registry (NOT the binding-decorators global one).
 */
export function provideFrameworkSingleton(): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        frameworkRegistry.push(new FrameworkBinding(target, target));
        return target;
    };
}

/**
 * Framework equivalent of @provideSingletonAs: binds the impl to a token (Symbol or abstract
 * class) as a singleton, into the webpieces framework registry.
 */
export function provideFrameworkSingletonAs<T>(serviceIdentifier: ServiceIdentifier<T>): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        frameworkRegistry.push(new FrameworkBinding(serviceIdentifier, target));
        return target;
    };
}

/**
 * Framework equivalent of @provideTransient: a NEW instance on every resolve. Use it for a
 * class a {@link Provider} hands out per call — e.g. one ProxyClient per API contract.
 */
// webpieces-disable no-function-outside-class -- a decorator factory cannot be a class method
export function provideFrameworkTransient(): ClassDecorator {
    // webpieces-disable no-any-unknown -- decorator target is any class constructor
    return (target: any) => {
        frameworkRegistry.push(new FrameworkBinding(target, target, 'transient'));
        return target;
    };
}

/**
 * Register a {@link Provider} subclass as the DI token that hands out `target` instances.
 *
 * The provider caches nothing; `target`'s own binding scope decides whether callers share one
 * instance (provideFrameworkSingleton -> lazy singleton) or get a fresh one each `get()`
 * (provideFrameworkTransient -> 1-to-many).
 *
 * The provider itself is a singleton — it holds only the resolve-lambda.
 *
 * `Provider<T>` is erased at runtime and cannot be its own token, so name one after T. The DI-graph
 * analyzer reads `target` from HERE, which is why it can draw `Consumer -> T` with no provider box:
 * a Provider is DI plumbing, not wiring anyone needs to see.
 *
 * ```typescript
 * // webpieces-disable no-symbol-di-tokens -- Provider<T> is erased at runtime; T names the token
 * export const PROXY_CLIENT_PROVIDER = Symbol.for('ProxyClientProvider');
 * bindFrameworkProvider(PROXY_CLIENT_PROVIDER, NodeProxyClient);
 *
 * constructor(@inject(PROXY_CLIENT_PROVIDER) private readonly provider: Provider<NodeProxyClient>) {}
 * ```
 */
// webpieces-disable no-function-outside-class -- registry side-effect, called at module scope beside the decorators
export function bindFrameworkProvider(token: ServiceIdentifier, target: AnyCtor): void {
    frameworkProviderRegistry.push(new FrameworkProviderBinding(token, target));
}

/**
 * Build a ContainerModule binding every provideFrameworkSingleton(As)/Transient class, then
 * every registered Provider. Load this into the webpieces framework + app containers (the
 * router does this) alongside the client's own buildProviderModule().
 */
export function buildFrameworkModule(): ContainerModule {
    return new ContainerModule((options: ContainerModuleLoadOptions) => {
        for (const binding of frameworkRegistry) {
            const bindTo = options.bind(binding.serviceIdentifier).to(binding.target);
            if (binding.scope === 'transient') {
                bindTo.inTransientScope();
            } else {
                bindTo.inSingletonScope();
            }
        }
        for (const binding of frameworkProviderRegistry) {
            // toDynamicValue so the provider closes over the ResolutionContext. Each get() then
            // re-resolves `target`, letting TARGET's scope decide shared-vs-fresh.
            options
                .bind(binding.token)
                .toDynamicValue((context: ResolutionContext) =>
                    new Provider(() => context.get(binding.target)))
                .inSingletonScope();
        }
    });
}
