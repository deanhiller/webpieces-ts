import { WebAppMeta, Routes } from '@webpieces/http-routing';
import { ContainerModule } from 'inversify';
import { InversifyModule } from './modules/InversifyModule';
import { FilterRoutes } from './routes/FilterRoutes';
import { RESTApiRoutes } from '@webpieces/http-routing';
import { SaveApi, SaveApiPrototype } from './api/SaveApi';
import { SaveController } from './controllers/SaveController';
import { PublicApiPrototype } from './api/PublicApi';
import { PublicController } from './controllers/PublicController';

/**
 * ProdServerMeta - Application metadata and configuration.
 * Similar to Java ProdServerMeta.
 *
 * This is the entry point that WebpiecesServer calls to configure
 * the application. It defines:
 * 1. DI modules (Inversify modules)
 * 2. Route configurations
 *
 * Usage:
 * ```typescript
 * const server = new WebpiecesServer(new ProdServerMeta());
 * server.start();
 * ```
 */
export class ProdServerMeta implements WebAppMeta {
    /**
     * Returns DI modules for dependency injection.
     * Similar to getDIModules() in Java.
     */
    getDIModules(): ContainerModule[] {
        return [InversifyModule];
    }

    /**
     * Returns route configurations.
     * Similar to getRouteModules() in Java.
     */
    getRoutes(): Routes[] {
        return [
            // Register filters first
            new FilterRoutes(),

            // Auto-wire SaveApiPrototype to SaveController
            // SaveApiPrototype is an abstract class with decorators (@Post, @Path)
            // SaveController extends SaveApiPrototype and implements SaveApi interface
            // Type-safe: RESTApiRoutes<SaveApiPrototype, SaveController>
            new RESTApiRoutes(SaveApiPrototype, SaveController),

            // Auto-wire PublicApiPrototype to PublicController
            new RESTApiRoutes(PublicApiPrototype, PublicController),
        ];
    }
}
