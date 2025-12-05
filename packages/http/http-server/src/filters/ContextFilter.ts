import { injectable, multiInject, optional } from 'inversify';
import { provideSingleton, MethodMeta } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import { PlatformHeader, PlatformHeadersExtension, HEADER_TYPES } from '@webpieces/http-api';

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
@provideSingleton()
@injectable()
export class ContextFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    private allHeaders: PlatformHeader[] = [];

    constructor(
        @multiInject(HEADER_TYPES.PlatformHeadersExtension) @optional()
        extensions: PlatformHeadersExtension[] = []
    ) {
        super();

        // Flatten all headers from all extensions
        for (const extension of extensions) {
            this.allHeaders.push(...extension.getHeaders());
        }

        console.log(`[ContextFilter] Collected ${this.allHeaders.length} platform headers from ${extensions.length} extensions`);
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Transfer platform headers from RouterRequest to RequestContext
        this.transferHeaders(meta);

        // Store request metadata in context for other filters/controllers to access
        RequestContext.put('METHOD_META', meta);
        RequestContext.put('REQUEST_PATH', meta.path);
        RequestContext.put('HTTP_METHOD', meta.httpMethod);

        // Execute next filter/controller
        return await nextFilter.invoke(meta);
        // RequestContext is auto-cleared by ExpressWrapper when request completes
    }

    /**
     * Transfer platform headers from RouterRequest to RequestContext.
     * Only transfers headers marked with isWantTransferred=true.
     *
     * @param meta - MethodMeta containing RouterReqResp
     */
    private transferHeaders(meta: MethodMeta): void {
        if (!meta.routerReqResp) {
            // No RouterReqResp (test mode using createApiClient)
            // Generate REQUEST_ID and skip header transfer
            this.ensureRequestId();
            return;
        }

        const headers = meta.routerReqResp.request.getHeaders();

        for (const header of this.allHeaders) {
            // Skip headers not marked for transfer
            if (!header.isWantTransferred) {
                continue;
            }

            // Read header value (case-insensitive)
            const value = headers.get(header.headerName.toLowerCase());
            if (value) {
                RequestContext.putHeader(header, value);
            }
        }

        // Generate REQUEST_ID if not present (first service in chain)
        this.ensureRequestId();
    }

    /**
     * Ensure REQUEST_ID is set in RequestContext.
     * Generates one if not present.
     */
    private ensureRequestId(): void {
        // Find REQUEST_ID header definition
        const requestIdHeader = this.allHeaders.find(h => h.headerName.toLowerCase() === 'x-request-id');

        if (requestIdHeader && !RequestContext.hasHeader(requestIdHeader)) {
            const requestId = this.generateRequestId();
            RequestContext.putHeader(requestIdHeader, requestId);
        }
    }

    /**
     * Generate a unique request ID.
     * Format: req-{timestamp}-{random}
     */
    private generateRequestId(): string {
        return `req-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
}

