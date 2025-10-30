import { fluentProvide, provide } from 'inversify-binding-decorators';

/**
 * Provides a singleton-scoped dependency.
 *
 * Unlike @injectable() which is transient (new instance every time),
 * @provideSingleton creates ONE instance that is reused throughout the app.
 *
 * Usage:
 * ```typescript
 * @provideSingleton(TYPES.Counter)
 * export class SimpleCounter implements Counter {
 *   // ...
 * }
 * ```
 */
export function provideSingleton(identifier: any) {
    return fluentProvide(identifier).inSingletonScope().done();
}

/**
 * Provides a transient-scoped dependency (new instance every time).
 * This is the default behavior of @injectable().
 */
export function provideTransient(identifier: any) {
    return provide(identifier);
}
