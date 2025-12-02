import { ContainerModule } from 'inversify';
import { Counter, SimpleCounter } from '../controllers/SaveController';
import { RemoteApi, TYPES } from '../remote/RemoteApi';
import { RemoteServiceSimulator } from '../remote/RemoteServiceSimulator';
import { JsonFilterConfig, FILTER_TYPES } from '@webpieces/http-server';

/**
 * InversifyModule - DI configuration module.
 *
 * Note: Controllers and Filters with @provideSingleton() are auto-registered
 * and don't need explicit bindings here. This module only contains:
 * - Service implementations (Counter, RemoteApi)
 * - Filter configurations (JsonFilterConfig)
 * - Other dependencies that need manual configuration
 *
 * All bindings use .inSingletonScope() to ensure ONE instance per application.
 */
export const InversifyModule = new ContainerModule((options) => {
    const { bind } = options;

    // Bind services
    bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
    bind<RemoteApi>(TYPES.RemoteApi).to(RemoteServiceSimulator).inSingletonScope();

    // Bind filter configurations
    // Create default JsonFilterConfig with validation enabled, logging disabled
    bind(FILTER_TYPES.JsonFilterConfig).to(JsonFilterConfig).inSingletonScope();
});
