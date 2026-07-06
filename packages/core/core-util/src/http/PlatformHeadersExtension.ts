import { PlatformHeader } from './PlatformHeader';

/**
 * PlatformHeadersExtension - Extension that contributes platform headers to the framework.
 *
 * This is a DI-level extension (not an app-level Plugin).
 * Multiple modules can bind PlatformHeadersExtension instances, and the framework
 * collects them via Inversify @multiInject.
 *
 * Two-level plugin system:
 * 1. **Extensions** (DI-level): Contribute specific capabilities to framework
 *    - Examples: PlatformHeadersExtension, BodyContentExtension, EntityLookupExtension
 *    - Pattern: Bound via multiInject, consumed by framework
 *    - Java equivalent: Multibinder<AddPlatformHeaders>, Multibinder<BodyContentBinder>
 *
 * 2. **Plugins** (App-level): Provide complete features with modules + routes
 *    - Examples: HibernatePlugin, JacksonPlugin, Auth0Plugin
 *    - Pattern: Implements getGuiceModules() + getRouteModules()
 *    - Java equivalent: Plugin interface with getGuiceModules() + getRouteModules()
 *
 * Usage:
 * ```typescript
 * // In WebpiecesModule
 * const coreExtension = new PlatformHeadersExtension([
 *     WebpiecesCoreHeaders.REQUEST_ID,
 *     WebpiecesCoreHeaders.CORRELATION_ID,
 * ]);
 * bind(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(coreExtension);
 *
 * // In CompanyModule
 * const companyExtension = new PlatformHeadersExtension([
 *     CompanyHeaders.TENANT_ID,
 *     CompanyHeaders.API_VERSION,
 * ]);
 * bind(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(companyExtension);
 *
 * // Framework collects all extensions
 * constructor(@multiInject(HEADER_TYPES.PlatformHeadersExtension) extensions: PlatformHeadersExtension[]) {}
 * ```
 */
export class PlatformHeadersExtension {
    /**
     * The set of platform headers contributed by this extension.
     */
    readonly headers: PlatformHeader[];

    constructor(headers: PlatformHeader[]) {
        this.headers = headers;
    }

    /**
     * Get all headers from this extension.
     * @returns Array of platform headers
     */
    getHeaders(): PlatformHeader[] {
        return this.headers;
    }
}
