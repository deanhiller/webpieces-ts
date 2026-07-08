import { injectable } from 'inversify';
import { provideFrameworkSingleton, MethodMeta } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-routing';
import { ContextKey, HeaderRegistry } from '@webpieces/core-util';
import {WebpiecesCoreHeaders} from "../headers/WebpiecesCoreHeaders";
import {ContextKeys} from "../headers/ContextKeys";
import { LogManager } from '@webpieces/core-util';

/**
 * ContextFilter - Transfers platform headers and stores request metadata in RequestContext.
 * Priority: 2000 (executes first in filter chain)
 *
 * NEW: Now handles header transfer from RouterRequest to RequestContext
 * - Injects PlatformHeadersExtension instances via @multiInject (safe because filter created after modules load)
 * - Reads headers from RouterRequest (Express-independent)
 * - Transfers only headers marked with isWantTransferred=true
 * - Generates REQUEST_ID if not present
 *
 * RequestContext lifecycle:
 * 1. ExpressWrapper.execute() calls RequestContext.run() (establishes context)
 * 2. ExpressWrapper creates RouterReqResp and MethodMeta
 * 3. Filter chain executes, starting with ContextFilter
 * 4. ContextFilter transfers headers from RouterRequest to RequestContext
 * 5. ContextFilter stores metadata (METHOD_META, REQUEST_PATH, HTTP_METHOD)
 * 6. Downstream filters and controller can access headers + metadata
 * 7. Context auto-clears when RequestContext.run() completes
 */
const log = LogManager.getLogger('ContextFilter');

@provideFrameworkSingleton()
@injectable()
export class ContextFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    private transferredKeys: ContextKey[];

    constructor() {
        super();

        // The global registry is the single source of truth (configured at startup,
        // duplicate-validated). No DI — HeaderRegistry.configure(...) ran first.
        const registry = HeaderRegistry.get();
        this.transferredKeys = registry.getTransferredKeys();

        log.info(`[ContextFilter] Using ${registry.getKeys().length} context keys from HeaderRegistry (${this.transferredKeys.length} transferred)`);
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Transfer platform headers from MethodMeta.requestHeaders to RequestContext
        this.transferHeaders(meta);

        // Store request metadata in context for other filters/controllers to access
        RequestContext.putHeader(ContextKeys.METHOD_META, meta);
        RequestContext.putHeader(ContextKeys.REQUEST_PATH, meta.path);
        RequestContext.putHeader(ContextKeys.HTTP_METHOD, meta.httpMethod);

        // Execute next filter/controller
        return await nextFilter.invoke(meta);
        // RequestContext is auto-cleared by ExpressWrapper when request completes
    }

    /**
     * Transfer transferred keys from MethodMeta.requestHeaders to RequestContext.
     * A key is transferred when it has an httpHeader (wire name); the value is read
     * from the incoming request under that httpHeader and stored under the key's name.
     */
    private transferHeaders(meta: MethodMeta): void {
        if (!meta.requestHeaders) {
            // No headers in test mode (createApiClient creates context but not headers)
            this.ensureRequestId();
            return;
        }

        // Transfer each key to RequestContext (read by wire name, store by key name).
        for (const key of this.transferredKeys) {
            // Get values from requestHeaders (case-insensitive lookup by wire name)
            const values = meta.requestHeaders.get(key.httpHeader!.toLowerCase());
            if (values && values.length > 0) {
                RequestContext.putHeader(key, values[0]);
            }
        }

        // Clear request headers from MethodMeta - MUST FORCE USAGE of RequestContext!!!
        meta.requestHeaders = undefined;

        // Generate REQUEST_ID if not present (first service in chain)
        this.ensureRequestId();
    }

    /**
     * Ensure REQUEST_ID is set in RequestContext.
     * Generates one if not present.
     */
    private ensureRequestId(): void {
        if (!RequestContext.hasHeader(WebpiecesCoreHeaders.REQUEST_ID)) {
            const requestId = this.generateRequestId();
            RequestContext.putHeader(WebpiecesCoreHeaders.REQUEST_ID, requestId);
        }
    }

    /**
     * Generate a unique request ID.
     * Format: req-{timestamp}-{random}
     */
    private generateRequestId(): string {
        return `svrGenReqId-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
}

