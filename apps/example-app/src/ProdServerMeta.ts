import { WebAppMeta, Routes } from '@webpieces/http-routing';
import { ContainerModule } from 'inversify';
import { WebpiecesModule } from '@webpieces/http-server';
import { CompanyModule } from './modules/CompanyModule';
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
     * Returns DI modules for dependency injection in loading order.
     * Similar to getDIModules() in Java.
     *
     * Three-tier module structure:
     * 1. WebpiecesModule (framework headers: x-request-id, x-correlation-id)
     * 2. CompanyModule (company headers: x-tenant-id, x-api-version)
     * 3. InversifyModule (app headers: x-client-type)
     *
     * All modules contribute PlatformHeader instances that are collected
     * via Inversify @multiInject pattern in WebpiecesMiddleware.
     */
    getDIModules(): ContainerModule[] {
        return [WebpiecesModule, CompanyModule, InversifyModule];
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
