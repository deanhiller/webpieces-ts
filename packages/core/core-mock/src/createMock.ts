import { MockHandler, ParametersPassedIn } from './MockHandler';

/**
 * TypedMockControls - The typed prime/assert facade exposed on mock.mock.
 * Method names are constrained to keyof T; primed values to the method's
 * awaited return type.
 */
export interface TypedMockControls<T> {
    // webpieces-disable no-any-unknown -- conditional type extracts the method's awaited return type
    addValueToReturn<K extends keyof T & string>(
        method: K,
        // webpieces-disable no-any-unknown -- conditional type extracts the method's awaited return type
        value: T[K] extends (...args: never[]) => unknown ? Awaited<ReturnType<T[K]>> : never,
    ): void;
    // webpieces-disable no-any-unknown -- supplier computes api-specific values at call time
    addCalculateRetValue<K extends keyof T & string>(method: K, supplier: () => unknown): void;
    addExceptionToThrow<K extends keyof T & string>(method: K, errorSupplier: () => Error): void;
    // webpieces-disable no-any-unknown -- conditional type extracts the method's awaited return type
    setDefaultReturnValue<K extends keyof T & string>(
        method: K,
        // webpieces-disable no-any-unknown -- conditional type extracts the method's awaited return type
        value: T[K] extends (...args: never[]) => unknown ? Awaited<ReturnType<T[K]>> : never,
    ): void;
    getCalledMethodList<K extends keyof T & string>(method: K): ParametersPassedIn[];
    getSingleRequestList<R, K extends keyof T & string = keyof T & string>(method: K): R[];
    clear(): void;
}

/**
 * MockedApi - The mock: implements T (every method resolves via MockHandler)
 * plus a typed `mock` control facade.
 */
export type MockedApi<T> = T & { mock: TypedMockControls<T> };

/**
 * createMock - Build a typed mock for an api interface/abstract class.
 *
 * Port of Java core-mock, minus the boilerplate: where Java requires a
 * hand-written `MockRemoteService extends MockSuperclass implements RemoteApi`
 * per api, a JS Proxy implements every method generically while keeping the
 * identical prime/assert vocabulary.
 *
 * ```typescript
 * const mockRemote = createMock<RemoteApi>('RemoteApi');
 * mockRemote.mock.addValueToReturn('fetchValue', { value: 'primed' });
 * rebind(TYPES.RemoteApi).toConstantValue(mockRemote);
 * // ... run the test ...
 * const reqs = mockRemote.mock.getSingleRequestList<FetchValueRequest>('fetchValue');
 * ```
 *
 * Every api method returns a Promise (webpieces apis are async by convention).
 */
export function createMock<T extends object>(apiName: string): MockedApi<T> {
    const handler = new MockHandler();

    // Properties that must NOT become mocked api methods
    const passthrough = new Set(['mock', 'then', 'catch', 'finally', 'constructor', 'toJSON']);

    return new Proxy({} as MockedApi<T>, {
        // webpieces-disable no-any-unknown -- Proxy get trap returns heterogeneous members
        get(target: MockedApi<T>, prop: string | symbol): unknown {
            if (typeof prop !== 'string') {
                return undefined;
            }
            if (prop === 'mock') {
                return handler;
            }
            if (passthrough.has(prop)) {
                return undefined;
            }
            // Any other property access is treated as an api method
            // webpieces-disable no-any-unknown -- api method args/returns are type-erased in the proxy
            return async (...args: unknown[]): Promise<unknown> => {
                return handler.calledMethod(prop, args);
            };
        },
    });
}
