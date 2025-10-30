import { ApiInterface, Post, Path } from '@webpieces/http-routing';
import { SaveRequest } from './SaveRequest';
import { SaveResponse } from './SaveResponse';

/**
 * DI token for SaveApi.
 * Used to register and resolve the SaveApi implementation in the DI container.
 */
export const SaveApiToken = Symbol.for('SaveApi');

/**
 * SaveApi - Pure interface defining the API contract.
 *
 * This is the type-safe contract that both server and client must follow.
 * Controllers implement this interface to ensure they provide all required methods.
 */
export interface SaveApi {
  save(request: SaveRequest): Promise<SaveResponse>;
}

/**
 * SaveApiPrototype - Abstract class with routing decorators.
 *
 * This class serves as the single source of truth for routing metadata:
 * 1. Server-side: RESTApiRoutes reads decorators to bind routes to controllers
 * 2. Client-side: Client generator reads decorators to create HTTP client proxies
 *
 * Pattern:
 * ```typescript
 * // 1. Define interface (contract)
 * interface SaveApi { ... }
 *
 * // 2. Define prototype with decorators (metadata)
 * abstract class SaveApiPrototype { ... }
 *
 * // 3. Controller extends prototype AND implements interface
 * class SaveController extends SaveApiPrototype implements SaveApi {
 *   // MUST override all methods from SaveApi
 *   // TypeScript will error if any are missing
 * }
 * ```
 *
 * Benefits:
 * - Decorators live on the prototype, not the implementation
 * - Interface enforces that all methods are implemented
 * - Same metadata used for server routing and client generation
 * - Compile error if controller doesn't implement a method
 * - Type-safe contract between client and server
 *
 * Note: Methods throw by default to catch runtime errors if not overridden.
 */
@ApiInterface()
export abstract class SaveApiPrototype implements SaveApi {
  @Post()
  @Path('/search/item')
  save(request: SaveRequest): Promise<SaveResponse> {
    throw new Error('Method save() must be implemented by subclass');
  }
}

/**
 * Type-level validator to ensure a class implements all methods from an interface.
 * Usage: Add to controller class declaration:
 *
 * ```typescript
 * export class SaveController extends SaveApiPrototype implements SaveApi {
 *   // Compile-time check: ensures all SaveApi methods are implemented
 *   private readonly __validator!: ValidateImplementation<SaveController, SaveApi>;
 * }
 * ```
 *
 * This will cause a compile error if SaveController is missing any methods from SaveApi.
 */
export type ValidateImplementation<TImpl, TInterface> = {
  [K in keyof TInterface]: K extends keyof TImpl
    ? TImpl[K] extends TInterface[K]
      ? TInterface[K]
      : never
    : never;
};
