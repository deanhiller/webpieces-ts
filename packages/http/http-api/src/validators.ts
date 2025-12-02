/**
 * Type-level validator to ensure a class implements all methods from an interface.
 *
 * This validator provides compile-time verification that an implementation
 * (e.g., controller, client, mock) fully implements an API interface.
 *
 * Usage in server-side controllers:
 * ```typescript
 * export class SaveController extends SaveApiPrototype implements SaveApi {
 *   // Compile-time check: ensures all SaveApi methods are implemented
 *   private readonly __validator!: ValidateImplementation<SaveController, SaveApi>;
 *
 *   save(request: SaveRequest): Promise<SaveResponse> {
 *     // implementation
 *   }
 * }
 * ```
 *
 * Usage in client-side implementations:
 * ```typescript
 * export class MockSaveClient implements SaveApi {
 *   private readonly __validator!: ValidateImplementation<MockSaveClient, SaveApi>;
 *
 *   save(request: SaveRequest): Promise<SaveResponse> {
 *     // mock implementation
 *   }
 * }
 * ```
 *
 * Benefits:
 * - Compile error if any interface method is missing
 * - Compile error if method signatures don't match
 * - Works with controllers, clients, mocks, stubs, etc.
 * - Type-safe contract enforcement
 *
 * Note: The `!` assertion is safe because this field is never accessed at runtime.
 * It only exists for compile-time type checking.
 */
export type ValidateImplementation<TImpl, TInterface> = {
    [K in keyof TInterface]: K extends keyof TImpl
        ? TImpl[K] extends TInterface[K]
            ? TInterface[K]
            : never
        : never;
};
