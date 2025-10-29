import { ContainerModule } from 'inversify';
import { SaveController, Counter, SimpleCounter } from '../controllers/SaveController';
import { RemoteApi, TYPES } from '../remote/RemoteApi';
import { RemoteServiceSimulator } from '../remote/RemoteServiceSimulator';
import { ContextFilter, JsonFilter } from '@webpieces/http-filters';

/**
 * GuiceModule - DI configuration module.
 * Similar to Java Guice Module.
 *
 * This module binds:
 * - Controllers
 * - Services
 * - Filters
 * - External dependencies
 */
export const GuiceModule = new ContainerModule((options) => {
  const { bind } = options;

  // Bind controllers
  bind(SaveController).toSelf().inSingletonScope();

  // Bind services
  bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
  bind<RemoteApi>(TYPES.RemoteApi).to(RemoteServiceSimulator).inSingletonScope();

  // Bind filters
  bind(ContextFilter).toSelf().inSingletonScope();
  bind(JsonFilter).toSelf().inSingletonScope();
});
