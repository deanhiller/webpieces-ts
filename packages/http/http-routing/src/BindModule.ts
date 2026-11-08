import type { BindModule as HostBindModule } from '@webpieces/http-client-core';
import type { Binder } from './Binder';

/** Named DI declaration. setupRuntime hands it the Node {@link Binder} over one Inversify load. */
export interface BindModule extends HostBindModule<Binder> {
    configure(binder: Binder): void | Promise<void>;
}
