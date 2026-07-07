import { ContainerModule } from 'inversify';
import type { ContainerModuleLoadOptions, ServiceIdentifier } from 'inversify';

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

class FrameworkBinding {
    constructor(
        public readonly serviceIdentifier: ServiceIdentifier,
        public readonly target: AnyCtor,
    ) {}
}

/** The webpieces-only binding registry (a plain module-level list, one per hosted core-context). */
const frameworkRegistry: FrameworkBinding[] = [];

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
 * Build a ContainerModule binding every provideFrameworkSingleton(As) class. Load this into
 * the webpieces framework + app containers (the router does this) alongside the client's own
 * buildProviderModule().
 */
export function buildFrameworkModule(): ContainerModule {
    return new ContainerModule((options: ContainerModuleLoadOptions) => {
        for (const binding of frameworkRegistry) {
            options.bind(binding.serviceIdentifier).to(binding.target).inSingletonScope();
        }
    });
}
