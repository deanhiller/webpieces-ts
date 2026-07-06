import { inject, injectable } from 'inversify';
import { provideSingleton, RequestContextReader, ContextMgr } from '@webpieces/core-context';
import { HeaderRegistry, DocumentDesign } from '@webpieces/core-util';
import { getCloudRunUrl } from '@webpieces/gcp-identity';
import { TaskInvoker } from './TaskTypes';
import { createTaskClient, TaskClientConfig } from './TaskClientFactory';

/** Constructor whose prototype is T (the abstract @PubSub API class). */
type ApiPrototype<T> = Function & { prototype: T };

/**
 * Injectable factory for Cloud Tasks enqueue clients — the twin of http-client's
 * RpcClientCreator. Resolves the bound TaskInvoker + a context-propagating ContextMgr
 * so a service just asks for a typed client:
 *
 *   const emailTasks = creator.createClientOnService(EmailApi, 'email-svc'); // self/other svc
 */
@DocumentDesign()
@provideSingleton()
@injectable()
export class TaskClientCreator {
    constructor(
        @inject(TaskInvoker) private readonly invoker: TaskInvoker,
        @inject(HeaderRegistry) private readonly registry: HeaderRegistry,
    ) {}

    /** Enqueue client whose delivery URL is another Cloud Run service (by name). */
    createClientOnService<T extends object>(apiClass: ApiPrototype<T>, serviceName: string): T {
        const config = new TaskClientConfig(
            () => getCloudRunUrl(serviceName),
            this.invoker,
            this.buildContextMgr(),
        );
        return createTaskClient(apiClass, config);
    }

    /** Enqueue client whose delivery URL is a fixed base URL. */
    createClientOnUrl<T extends object>(apiClass: ApiPrototype<T>, url: string): T {
        const config = new TaskClientConfig(url, this.invoker, this.buildContextMgr());
        return createTaskClient(apiClass, config);
    }

    private buildContextMgr(): ContextMgr {
        return new ContextMgr(new RequestContextReader(), this.registry);
    }
}
