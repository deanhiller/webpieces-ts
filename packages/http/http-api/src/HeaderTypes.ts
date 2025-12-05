/**
 * DI symbols for platform headers system.
 *
 * Uses Symbol.for() to create global symbols that work across module boundaries.
 * This is important for Inversify multiInject pattern where multiple modules
 * bind to the same symbol.
 */
export const HEADER_TYPES = {
    /**
     * Symbol for PlatformHeadersExtension instances.
     * Multiple modules can bind PlatformHeadersExtension instances to this symbol,
     * and consumers can use @multiInject to collect all of them.
     *
     * Pattern: Extension (DI-level) vs Plugin (App-level)
     * - Extensions contribute specific capabilities to framework (headers, converters, etc.)
     * - Plugins provide complete features with modules + routes (Hibernate, Jackson, etc.)
     *
     * Usage:
     * ```typescript
     * // In a module
     * const extension = new PlatformHeadersExtension([header1, header2]);
     * bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(extension);
     *
     * // In a consumer
     * constructor(@multiInject(HEADER_TYPES.PlatformHeadersExtension) extensions: PlatformHeadersExtension[]) {}
     * ```
     */
    PlatformHeadersExtension: Symbol.for('PlatformHeadersExtension'),
};
