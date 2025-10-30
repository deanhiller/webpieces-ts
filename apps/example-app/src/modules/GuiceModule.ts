import { ContainerModule } from 'inversify';
import { SaveController, Counter, SimpleCounter } from '../controllers/SaveController';
import { SaveApiToken } from '../api/SaveApi';
import { RemoteApi, TYPES } from '../remote/RemoteApi';
import { RemoteServiceSimulator } from '../remote/RemoteServiceSimulator';
import { ContextFilter, JsonFilter } from '@webpieces/http-filters';

/**
 * GuiceModule - DI configuration module.
 * Similar to Java Guice Module and trytami's inversify.ts.
 *
 * All bindings use .inSingletonScope() to ensure ONE instance per application
 * (unlike @injectable() default which is transient - new instance every time).
 */
export const GuiceModule = new ContainerModule((bind) => {
  // Bind controllers to their API interfaces
  bind(SaveApiToken).to(SaveController).inSingletonScope();
  bind(SaveController).toSelf().inSingletonScope();

  // Bind services
  bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
  bind<RemoteApi>(TYPES.RemoteApi).to(RemoteServiceSimulator).inSingletonScope();

  // Bind filters
  bind(ContextFilter).toSelf().inSingletonScope();
  bind(JsonFilter).toSelf().inSingletonScope();
});
