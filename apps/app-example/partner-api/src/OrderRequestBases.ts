/**
 * The BASES `FetchOrdersRequest` extends — in their own file, two levels deep, so the golden proves
 * the generator flattens inherited fields across files into both the OpenAPI document and the MCP
 * tool catalog (#1055). The wire document of a request is every field it has, not only its own.
 */

/** Any request addressed to one store. */
export interface StoreScopedRequest {
    /** The store to read. */
    storeId: string;
}

/** A store-scoped request that reads a window of time. */
export interface WindowedStoreRequest extends StoreScopedRequest {
    /**
     * Window start, inclusive. `FetchOrdersRequest` redeclares this field with its own prose, and
     * the redeclaration is what publishes.
     * @format date-time
     */
    from?: string;
}
