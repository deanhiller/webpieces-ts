import { ContainerModule } from 'inversify';
import { HEADER_TYPES, PlatformHeadersExtension, HeaderMethods } from '@webpieces/http-api';
import { WebpiecesCoreHeaders } from '../headers/WebpiecesCoreHeaders';

/**
 * WebpiecesModule - Framework-level DI bindings.
 *
 * This module is loaded by WebpiecesFactory BEFORE application modules.
 * It provides core framework services including platform headers.
 *
 * Platform Headers Pattern (Extension):
 * - Create PlatformHeadersExtension with array of headers
 * - Bind extension to HEADER_TYPES.PlatformHeadersExtension symbol
 * - Multiple modules bind their own extensions
 * - Consumer uses @multiInject to collect all extensions
 * - Pattern inspired by Guice Multibinder
 *
 * Module Loading Order:
 * 1. WebpiecesModule (framework headers) ← YOU ARE HERE
 * 2. CompanyModule (company-wide headers)
 * 3. InversifyModule (app-specific headers)
 */
export const WebpiecesModule = new ContainerModule((options) => {
    const { bind } = options;

    // Bind HeaderMethods as singleton (stateless utility, can be shared)
    bind<HeaderMethods>(HeaderMethods).toSelf().inSingletonScope();

    // Create extension with core headers
    const coreExtension = new PlatformHeadersExtension(WebpiecesCoreHeaders.getAllHeaders());

    // Bind extension for multiInject collection
    // WebpiecesMiddleware will collect all PlatformHeadersExtension bindings via @multiInject
    bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(coreExtension);

    console.log(`[WebpiecesModule] Registered core platform headers extension with ${coreExtension.headers.length} headers`);
});
