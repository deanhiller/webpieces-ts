import {inject, injectable, multiInject, optional} from 'inversify';
import { provideSingleton, MethodMeta } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import { PlatformHeader, PlatformHeadersExtension, HeaderMethods, HEADER_TYPES } from '@webpieces/http-api';
import {WebpiecesCoreHeaders} from "../headers/WebpiecesCoreHeaders";

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
    private headerMethods: PlatformHeader[];

    constructor(
        @multiInject(HEADER_TYPES.PlatformHeadersExtension) @optional()
        extensions: PlatformHeadersExtension[] = [],
        @inject(HeaderMethods) headerMethods: HeaderMethods
    ) {
        super();

        // Flatten all headers from all extensions
        const allHeaders: PlatformHeader[] = [];
        for (const extension of extensions) {
            allHeaders.push(...extension.getHeaders());
        }

        // Create HeaderMethods helper with flattened headers
        this.headerMethods = headerMethods.findTransferHeaders(allHeaders);

        console.log(`[ContextFilter] Collected ${allHeaders.length} platform headers from ${extensions.length} extensions`);
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Transfer platform headers from MethodMeta.requestHeaders to RequestContext
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
     * Transfer platform headers from MethodMeta.requestHeaders to RequestContext.
     * Uses HeaderMethods.findTransferHeaders() to filter by isWantTransferred=true.
     */
    private transferHeaders(meta: MethodMeta): void {
        if (!meta.requestHeaders) {
            // No headers in test mode
            this.ensureRequestId();
            return;
        }

        // Transfer each header to RequestContext using RequestContext.putHeader()
        for (const header of this.headerMethods) {
            // Get values from requestHeaders (case-insensitive lookup)
            const values = meta.requestHeaders.get(header.headerName.toLowerCase());
            if (values && values.length > 0) {
                // Use RequestContext.putHeader() which calls header.getHeaderName()
                RequestContext.putHeader(header, values[0]);
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

