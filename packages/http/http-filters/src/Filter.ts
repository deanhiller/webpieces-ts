/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request information.
 *
 * Use withParams() to create modified copies when needed.
 */
export class MethodMeta {
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
   * Filters can modify this directly OR use withParams() to create a new instance.
   */
  params: unknown[];

  /**
   * The original request object (if applicable)
   */
  request?: unknown;

  /**
   * The response object (Express Response for writing)
   */
  response?: unknown;

  /**
   * Additional metadata
   */
  metadata?: Map<string, unknown>;

  constructor(
    httpMethod: string,
    path: string,
    methodName: string,
    params: unknown[],
    request?: unknown,
    response?: unknown,
    metadata?: Map<string, unknown>
  ) {
    this.httpMethod = httpMethod;
    this.path = path;
    this.methodName = methodName;
    this.params = params;
    this.request = request;
    this.response = response;
    this.metadata = metadata;
  }
}

/**
 * ResponseWrapper - Wraps controller responses for the filter chain.
 *
 * Generic type parameter TResult represents the controller's return type.
 * The filter chain uses ResponseWrapper<unknown> because it handles all response types uniformly.
 *
 * JsonFilter is responsible for:
 * 1. Serializing ResponseWrapper.response to JSON
 * 2. Writing the JSON to the HTTP response body
 */
export class ResponseWrapper<TResult = unknown> {
  response?: TResult;
  statusCode: number;
  headers: Map<string, string>;

  constructor(response?: TResult, statusCode: number = 200) {
    this.response = response;
    this.statusCode = statusCode;
    this.headers = new Map();
  }

  /**
   * Set a response header.
   */
  setHeader(name: string, value: string): ResponseWrapper<TResult> {
    this.headers.set(name, value);
    return this;
  }

  /**
   * Create an error response wrapper.
   */
  static error<T = unknown>(message: string, statusCode: number = 500): ResponseWrapper<T> {
    const wrapper = new ResponseWrapper<T>(undefined, statusCode);
    wrapper.setHeader('X-Error', message);
    return wrapper;
  }
}

/**
 * Service interface - Similar to Java WebPieces Service<REQ, RESP>.
 * Represents any component that can process a request and return a response.
 *
 * Used for:
 * - Final controller invocation
 * - Wrapping filters as services in the chain
 * - Functional composition of filters
 */
export interface Service<REQ, RESP> {
  /**
   * Invoke the service with the given metadata.
   * @param meta - Request metadata
   * @returns Promise of the response
   */
  invoke(meta: REQ): Promise<RESP>;
}

/**
 * Filter abstract class - Similar to Java WebPieces Filter<REQ, RESP>.
 *
 * Filters are STATELESS and can handle N concurrent requests.
 * They wrap the execution of subsequent filters and the controller.
 *
 * Key principles:
 * - STATELESS: No instance variables for request data
 * - Can modify meta directly OR use withParams() for immutability
 * - COMPOSABLE: Use chain() methods for functional composition
 *
 * For HTTP filters, use Filter<MethodMeta, ResponseWrapper<unknown>>:
 * - MethodMeta: Standardized request metadata
 * - ResponseWrapper<unknown>: Wraps any controller response
 *
 * Example:
 * ```typescript
 * @injectable()
 * export class LoggingFilter extends Filter<MethodMeta, ResponseWrapper<unknown>> {
 *
 *   async filter(
 *     meta: MethodMeta,
 *     nextFilter: Service<MethodMeta, ResponseWrapper<unknown>>
 *   ): Promise<ResponseWrapper<unknown>> {
 *     console.log(`Request: ${meta.httpMethod} ${meta.path}`);
 *     const response = await nextFilter.invoke(meta);
 *     console.log(`Response: ${response.statusCode}`);
 *     return response;
 *   }
 * }
 * ```
 *
 * Composition example:
 * ```typescript
 * const service = contextFilter
 *   .chain(jsonFilter)
 *   .chain(loggingFilter)
 *   .chainService(controller);
 *
 * const response = await service.invoke(meta);
 * ```
 */
export abstract class Filter<REQ, RESP> {

  //priority is determined by how it is chained only here
  //DO NOT add priority here

  /**
   * Filter method that wraps the next filter/controller.
   *
   * Filters can modify meta:
   * - Option 1: Direct mutation: `meta.params[0] = value`
   * - Option 2: Immutable: `const newMeta = meta.withParams([value]); return nextFilter.invoke(newMeta);`
   *
   * @param meta - Metadata about the method being invoked
   * @param nextFilter - Next filter/controller as a Service
   * @returns Promise of the response
   */
  abstract filter(
    meta: REQ,
    nextFilter: Service<REQ, RESP>
  ): Promise<RESP>;

  /**
   * Chain this filter with another filter.
   * Returns a new Filter that composes both filters.
   *
   * Similar to Java: filter1.chain(filter2)
   *
   * @param nextFilter - The filter to execute after this one
   * @returns Composed filter
   */
  chain(nextFilter: Filter<REQ, RESP>): Filter<REQ, RESP> {
    const self = this;

    return new class extends Filter<REQ, RESP> {
      async filter(
        meta: REQ,
        nextService: Service<REQ, RESP>
      ): Promise<RESP> {
        // Call outer filter, passing next filter wrapped as a Service
        return self.filter(meta, {
          invoke: (m: REQ) => nextFilter.filter(m, nextService)
        });
      }
    };
  }

  /**
   * Chain this filter with a final service (controller).
   * Returns a Service that can be invoked.
   *
   * Similar to Java: filter.chain(service)
   *
   * @param svc - The final service (controller) to execute
   * @returns Service wrapping the entire filter chain
   */
  chainService(svc: Service<REQ, RESP>): Service<REQ, RESP> {
    const self = this;

    return {
      invoke: (meta: REQ) => self.filter(meta, svc)
    };
  }
}
