import { MethodMeta } from './MethodMeta';

/**
 * Handler class for routes.
 * Takes a MethodMeta and returns the controller method result.
 *
 * Generic type parameter TResult represents the return type of the controller method.
 * Example: RouteHandler<SaveResponse> for a method that returns Promise<SaveResponse>
 *
 * Using unknown as default instead of any forces type safety - consumers must
 * handle the result appropriately rather than assuming any type.
 *
 * This is a class instead of a function type to make it easier to trace
 * who is calling what in the debugger/IDE.
 */
export abstract class RouteHandler<TResult = unknown> {
  /**
   * Execute the route handler.
   * @param meta - The method metadata containing request info and params
   * @returns Promise of the controller method result
   */
  abstract execute(meta: MethodMeta): Promise<TResult>;
}
