import { injectable } from 'inversify';
import { Context } from '@webpieces/core-context';
import { Filter, MethodMeta, Action, NextFilter } from '../Filter';

/**
 * ContextFilter - Sets up AsyncLocalStorage context for each request.
 * Priority: 140 (executes first)
 *
 * This filter ensures that all subsequent filters and the controller
 * execute within a context that can store request-scoped data.
 */
@injectable()
export class ContextFilter implements Filter {
  priority = 140;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Run the rest of the filter chain within a new context
    return Context.run(async () => {
      // Store request metadata in context for other filters to access
      Context.put('METHOD_META', meta);
      Context.put('REQUEST_PATH', meta.path);
      Context.put('HTTP_METHOD', meta.httpMethod);

        return await next.execute();
        //NO NEED for finally block
        // Clean up context
          // (AsyncLocalStorage handles clear automatically,
    });
  }
}
