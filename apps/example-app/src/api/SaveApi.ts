import { ApiInterface, Post, Path } from '@webpieces/http-routing';
import { SaveRequest } from './SaveRequest';
import { SaveResponse } from './SaveResponse';

/**
 * SaveApi interface.
 * This is the contract that the controller must implement.
 *
 * Similar to Java:
 * ```java
 * public interface SaveApi {
 *   @POST
 *   @Path("/search/item")
 *   public XFuture<SaveResponse> save(SaveRequest request);
 * }
 * ```
 *
 * Note: In TypeScript, we use native Promise instead of XPromise/XFuture.
 * Unlike Java's ThreadLocal, Node.js AsyncLocalStorage automatically propagates
 * context across ALL async boundaries (promises, callbacks, async/await).
 * No manual context management needed!
 */
export interface SaveApi {
  save(request: SaveRequest): Promise<SaveResponse>;
}

/**
 * SaveApiMeta - API interface with routing decorators.
 * This class defines the routing metadata using decorators.
 *
 * RESTApiRoutes will reflect over this class to extract route information.
 */
@ApiInterface()
export class SaveApiMeta {
  @Post()
  @Path('/search/item')
  static save(request: SaveRequest): Promise<SaveResponse> {
    // This method is never called - it exists only to hold metadata
    throw new Error('Interface method should not be called');
  }
}
