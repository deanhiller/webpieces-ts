import { injectable } from 'inversify';
import { provideSingleton } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, MethodMeta, Action, NextFilter } from '../Filter';

/**
 * ContextFilter - Sets up AsyncLocalStorage context for each request.
 * Priority: 140 (executes first)
 *
 * This filter ensures that all subsequent filters and the controller
 * execute within a context that can store request-scoped data.
 */
@provideSingleton()
@injectable()
export class ContextFilter implements Filter {
  priority = 140;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Run the rest of the filter chain within a new context
    return RequestContext.run(async () => {
      // Store request metadata in context for other filters to access
      RequestContext.put('METHOD_META', meta);
      RequestContext.put('REQUEST_PATH', meta.path);
      RequestContext.put('HTTP_METHOD', meta.httpMethod);

      return await next.execute();
      //RequestContext is auto cleared when done.
    });
  }
}
