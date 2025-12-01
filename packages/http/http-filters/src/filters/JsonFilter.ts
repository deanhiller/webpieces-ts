import { injectable, inject } from 'inversify';
import { provideSingleton } from '@webpieces/http-routing';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { Filter, MethodMeta, Action, NextFilter, jsonAction, errorAction } from '../Filter';
import { RequestContext } from '@webpieces/core-context';
import { toError } from '@webpieces/core-util';

/**
 * DI tokens for http-filters.
 */
export const FILTER_TYPES = {
  JsonFilterConfig: Symbol.for('JsonFilterConfig'),
};

/**
 * Configuration for JsonFilter.
 * Register this in your DI container to customize JsonFilter behavior.
 *
 * Example:
 * ```typescript
 * export const MyModule = new ContainerModule((bind) => {
 *   bind(FILTER_TYPES.JsonFilterConfig).toConstantValue(
 *     new JsonFilterConfig(true, true) // validation enabled, logging enabled
 *   );
 * });
 * ```
 */
@injectable()
export class JsonFilterConfig {
  /**
   * Whether to enable validation using class-validator.
   * Default: true
   */
  validationEnabled: boolean;

  /**
   * Whether to log requests and responses.
   * Default: false
   */
  loggingEnabled: boolean;

  constructor(
    validationEnabled: boolean = true,
    loggingEnabled: boolean = false
  ) {
    this.validationEnabled = validationEnabled;
    this.loggingEnabled = loggingEnabled;
  }
}

/**
 * JsonFilter - Handles JSON deserialization and serialization.
 * Priority: 60
 *
 * Similar to Java WebPieces JacksonCatchAllFilter.
 *
 * Responsibilities:
 * 1. Deserialize request body to DTO (if request has body)
 * 2. Validate DTO using class-validator (if enabled)
 * 3. Execute next filter/controller
 * 4. Serialize response to JSON
 * 5. Handle errors and translate to JSON error responses
 *
 * Configuration:
 * JsonFilter uses constructor injection to receive JsonFilterConfig.
 * The default config has validation enabled and logging disabled.
 * To customize, bind JsonFilterConfig in your DI module.
 */
@provideSingleton()
@injectable()
export class JsonFilter implements Filter {
  priority = 60;

  constructor(@inject(FILTER_TYPES.JsonFilterConfig) private config: JsonFilterConfig) {
    // Config is injected from DI container
  }

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    try {
      // Deserialize and validate request if there's a body
      await this.processRequest(meta);

      if (this.config.loggingEnabled) {
        this.logRequest(meta);
      }

      // Execute next filter/controller
      const action = await next.execute();

      if (this.config.loggingEnabled) {
        this.logResponse(action);
      }

      // Ensure response is JSON
      if (action.type !== 'json' && action.type !== 'error') {
        return jsonAction(action.data);
      }

      return action;
    } catch (err: any) {
      const error = toError(err);
      // Translate error to JSON response
      return this.handleError(error, meta);
    }
  }

  /**
   * Process the request: deserialize and validate.
   */
  private async processRequest(meta: MethodMeta): Promise<void> {
    // If there's request data and a parameter type, deserialize it
    if (meta.request?.body && meta.params.length === 0) {
      const body = meta.request.body;

      // For now, we'll just pass the body as-is
      // In a real implementation, we'd use the parameter type from decorators
      // to properly deserialize and validate

      // If we have type information, we can do proper transformation
      // For this MVP, we'll store the body in params[0]
      meta.params[0] = body;

      // If validation is enabled and we have a class instance, validate it
      if (this.config.validationEnabled && body.constructor !== Object) {
        await this.validateDto(body);
      }
    }
  }

  /**
   * Validate a DTO using class-validator.
   */
  private async validateDto(dto: any): Promise<void> {
    const errors = await validate(dto);

    if (errors.length > 0) {
      const messages = this.formatValidationErrors(errors);
      throw new ValidationException(messages);
    }
  }

  /**
   * Format validation errors into a readable format.
   */
  private formatValidationErrors(errors: ValidationError[]): string[] {
    const messages: string[] = [];

    for (const error of errors) {
      if (error.constraints) {
        const constraints = Object.values(error.constraints);
        messages.push(...constraints);
      }

      if (error.children && error.children.length > 0) {
        const childMessages = this.formatValidationErrors(error.children);
        messages.push(...childMessages);
      }
    }

    return messages;
  }

  /**
   * Handle errors and translate to JSON error responses.
   */
  private handleError(error: any, meta: MethodMeta): Action {
    if (error instanceof ValidationException) {
      return errorAction(
        {
          error: 'Validation failed',
          violations: error.violations,
        } as any,
        400
      );
    }

    if (error instanceof HttpException) {
      return errorAction(
        {
          error: error.message,
          code: error.statusCode,
        } as any,
        error.statusCode
      );
    }

    // Log unexpected errors
    console.error('Unexpected error in filter chain:', error);

    return errorAction(
      'Internal server error',
      500
    );
  }

  /**
   * Log the incoming request.
   */
  private logRequest(meta: MethodMeta): void {
    console.log(`[JsonFilter] ${meta.httpMethod} ${meta.path}`);
    if (meta.params.length > 0) {
      console.log('[JsonFilter] Request body:', JSON.stringify(meta.params[0], null, 2));
    }
  }

  /**
   * Log the outgoing response.
   */
  private logResponse(action: Action): void {
    console.log(`[JsonFilter] Response: ${action.statusCode}`);
    if (action.data) {
      console.log('[JsonFilter] Response body:', JSON.stringify(action.data, null, 2));
    }
  }
}

/**
 * Exception thrown when validation fails.
 */
export class ValidationException extends Error {
  constructor(public violations: string[]) {
    super('Validation failed');
    this.name = 'ValidationException';
  }
}

/**
 * HTTP exception with status code.
 */
export class HttpException extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'HttpException';
  }
}
