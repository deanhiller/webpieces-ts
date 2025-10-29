import { XPromise } from '@webpieces/core-future';

/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request information.
 */
export interface MethodMeta {
  /**
   * The HTTP method (GET, POST, etc.)
   */
  httpMethod: string;

  /**
   * The request path
   */
  path: string;

  /**
   * The method name being invoked on the controller
   */
  methodName: string;

  /**
   * Parameters to pass to the controller method.
   * Filters can modify this array (e.g., JsonFilter deserializes request body into params[0])
   */
  params: any[];

  /**
   * The original request object (if applicable)
   */
  request?: any;

  /**
   * The response object (if applicable)
   */
  response?: any;

  /**
   * Additional metadata
   */
  metadata?: Map<string, any>;
}

/**
 * Action returned by filters and controllers.
 * Can represent different types of responses.
 */
export interface Action {
  type: 'json' | 'html' | 'redirect' | 'error';
  data?: any;
  statusCode?: number;
  headers?: Record<string, string>;
}

/**
 * Next filter function type.
 */
export type NextFilter = () => Promise<Action>;

/**
 * Filter interface.
 * Similar to Java WebPieces RouteFilter.
 *
 * Filters are executed in priority order (higher priority first)
 * and can wrap the execution of subsequent filters and the controller.
 *
 * Example:
 * ```typescript
 * @injectable()
 * export class LoggingFilter implements Filter {
 *   priority = 100;
 *
 *   async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
 *     console.log(`Request: ${meta.httpMethod} ${meta.path}`);
 *     const action = await next();
 *     console.log(`Response: ${action.statusCode}`);
 *     return action;
 *   }
 * }
 * ```
 */
export interface Filter {
  /**
   * Priority of this filter.
   * Higher numbers execute first.
   * Typical values:
   * - 140: Context setup
   * - 120: Request attributes
   * - 90: Metrics
   * - 80: Logging
   * - 60: JSON serialization
   * - 40: Transactions
   * - 0: Controller
   */
  priority: number;

  /**
   * Filter method that wraps the next filter/controller.
   *
   * @param meta - Metadata about the method being invoked
   * @param next - Function to invoke the next filter in the chain
   * @returns Promise of the action to return
   */
  filter(meta: MethodMeta, next: NextFilter): Promise<Action>;
}

/**
 * Helper to create a JSON action response.
 */
export function jsonAction(data: any, statusCode: number = 200): Action {
  return {
    type: 'json',
    data,
    statusCode,
  };
}

/**
 * Helper to create an error action response.
 */
export function errorAction(
  error: Error | string,
  statusCode: number = 500
): Action {
  return {
    type: 'error',
    data: {
      error: typeof error === 'string' ? error : error.message,
    },
    statusCode,
  };
}
