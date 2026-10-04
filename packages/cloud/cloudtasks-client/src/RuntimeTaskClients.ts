import type { ContainerModuleLoadOptions, ServiceIdentifier } from 'inversify';
import type { ApiPrototype } from './TaskClientConfig';
import { TaskClientConfig } from './TaskClientConfig';
import { ClientCloudTasksFactory } from './ClientCloudTasksFactory';

/** Lazy singleton enqueue bindings; constructing this module never schedules or delivers work. */
export class RuntimeTaskClients {
    constructor(private readonly options: ContainerModuleLoadOptions) {}

    bindPubSub<T extends object>(
        token: ServiceIdentifier<NoInfer<T>>,
        api: ApiPrototype<T>,
        target: string,
    ): void {
        this.options
            .bind<T>(token)
            .toDynamicValue((context) =>
                context
                    .get(ClientCloudTasksFactory)
                    .createPubSubClient(api, new TaskClientConfig(target)),
            )
            .inSingletonScope();
    }
}
