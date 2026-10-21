/**
 * ONE `ContextKey` the generated contract lists with `@ExternalContextKeys(...)`, named the way the
 * contract IMPORTS it: `{ "from": "@myorg/vendor-keys", "symbol": "VendorKeys.MERCHANT_ID" }` emits
 * `import { VendorKeys } from '@myorg/vendor-keys';` and `VendorKeys.MERCHANT_ID`.
 */
export class ContextKeyRef {
    constructor(
        /** The module the key's owner is imported from. */
        readonly from: string,
        /** A dotted path whose FIRST segment is the imported name, e.g. `VendorKeys.MERCHANT_ID`. */
        readonly symbol: string,
    ) {}

    /** The name the generated file imports from {@link from}. */
    importedName(): string {
        return this.symbol.split('.')[0];
    }
}

/**
 * The per-vendor import file — NOT `webpieces.config.json`, which holds repo rule config with
 * schemas and no defaults. One file per vendor, beside the contract it generates:
 *
 * ```json
 * {
 *   "spec": "spec/vendor-openapi.json",
 *   "contract": "VendorApi",
 *   "auth": { "vendorAuth": "vendor" },
 *   "contextKeys": {
 *     "*": [{ "from": "@myorg/vendor-keys", "symbol": "VendorKeys.MERCHANT_ID" }],
 *     "orders.DeleteOrder": []
 *   },
 *   "operations": ["items.GetItems", "orders.DeleteOrder"]
 * }
 * ```
 */
export class ImportConfig {
    constructor(
        /** The absolute path of the import file itself. */
        readonly configPath: string,
        /** The vendor's OpenAPI 3.0/3.1 JSON document, resolved to an absolute path. */
        readonly specPath: string,
        /** {@link specPath} exactly as the import file wrote it — printed in the generated banner. */
        readonly specAsWritten: string,
        /** The generated `@ApiPath` class name, e.g. `VendorApi`. */
        readonly contract: string,
        /** The `vendorAuth(name)` every generated endpoint declares. */
        readonly vendorAuth: string,
        /** `"*"` -> class-level `@ExternalContextKeys`. */
        readonly classContextKeys: readonly ContextKeyRef[],
        /** operationId -> method-level `@ExternalContextKeys` (ADDED to the class-level ones). */
        readonly methodContextKeys: ReadonlyMap<string, readonly ContextKeyRef[]>,
        /** The operations to generate, by operationId, in the order the contract lists them. */
        readonly operations: readonly string[],
    ) {}
}
