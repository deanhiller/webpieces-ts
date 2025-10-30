import { fluentProvide, provide } from 'inversify-binding-decorators';

/**
 * Provides a singleton-scoped dependency.
 */
export function provideSingleton(identifier: any) {
    return fluentProvide(identifier).inSingletonScope().done();
}

/**
 * Provides a transient-scoped dependency (new instance every time).
 */
export function provideTransient(identifier: any) {
    return provide(identifier);
}
