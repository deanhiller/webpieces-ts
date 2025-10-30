import { WebAppMeta, Routes } from '@webpieces/core-meta';
import { ContainerModule } from 'inversify';
import { GuiceModule } from './modules/GuiceModule';
import { FilterRoutes } from './routes/FilterRoutes';
import { RESTApiRoutes } from '@webpieces/http-routing';
import { SaveApiPrototype } from './api/SaveApi';
import { SaveController } from './controllers/SaveController';

/**
 * ProdServerMeta - Application metadata and configuration.
 * Similar to Java ProdServerMeta.
 *
 * This is the entry point that WebpiecesServer calls to configure
 * the application. It defines:
 * 1. DI modules (Guice modules)
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
   * Similar to getGuiceModules() in Java.
   */
  getDIModules(): ContainerModule[] {
    return [GuiceModule];
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
      new RESTApiRoutes(SaveApiPrototype, SaveController),
    ];
  }
}
