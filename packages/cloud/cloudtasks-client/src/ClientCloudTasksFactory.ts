import { inject, injectable } from 'inversify';
import { provideFrameworkSingleton, RequestContextReader, ContextMgr } from '@webpieces/core-context';
import { TaskInvoker } from './TaskTypes';
import { TaskProxyClient } from './TaskProxyClient';
import { ApiPrototype, TaskClientConfig } from './TaskClientConfig';

/**
 * Properties DI frameworks / Promise checks / serializers probe on the proxy; return
 * undefined instead of treating them as endpoints. Mirrors http-client's ClientHttpFactory.
 */
const FRAMEWORK_INSPECTION_PROPERTIES = new Set<string>([
    'constructor', 'prototype', '__proto__', 'name', 'then', 'catch', 'finally',
    'toJSON', 'valueOf', 'toString', 'nodeType', 'tagName', '$$typeof',
]);

/**
 * ClientCloudTasksFactory - builds Cloud Tasks enqueue clients from a shared @PubSub API
 * contract. The fire-and-forget twin of http-client's ClientHttpFactory.
 *
 * Calling a method on the returned client ENQUEUES a task (it does not call remotely);
 * the task is later delivered to the same endpoint's controller through the full server
 * filter chain. A service just asks for a typed client:
 *
 * ```typescript
 * const emailTasks = factory.createClient(EmailApi, new TaskClientConfig('email-svc'));
 * await scheduler.addToQueue(() => emailTasks.sendEmail(req), { dedupName });
 * ```
 *
 * The factory holds the COLLABORATORS every client shares (the bound TaskInvoker, and a
 * context-propagating ContextMgr); {@link TaskClientConfig} holds only that one client's
 * STATE (which Cloud Run service the task is delivered to).
 *
 * Unlike http-client — which Angular bundles into a browser and which therefore must stay
 * DI-agnostic — this package is node-only, so the factory IS the inversify entry point and
 * the ContextMgr is a fixed field: RequestContextReader is the one and only right reader.
 */
@provideFrameworkSingleton()
@injectable()
export class ClientCloudTasksFactory {
    private readonly contextMgr = new ContextMgr(new RequestContextReader());

    constructor(
        @inject(TaskInvoker) private readonly invoker: TaskInvoker,
    ) {}

    /** Typed enqueue client for a @PubSub contract, delivered to `config.gcpCloudRunSvcName`. */
    createClient<T extends object>(apiClass: ApiPrototype<T>, config: TaskClientConfig): T {
        // TaskProxyClient owns @PubSub validation + plan building from the contract's
        // decorators. It is the @DocumentDesign design root for this package.
        const proxyClient = new TaskProxyClient(apiClass, config, this.invoker, this.contextMgr);

        return new Proxy({} as T, {
            // webpieces-disable no-any-unknown -- proxy get trap returns either an endpoint method or undefined
            get(target: T, prop: string | symbol): unknown {
                if (typeof prop !== 'string' || FRAMEWORK_INSPECTION_PROPERTIES.has(prop)) {
                    return undefined;
                }
                if (!proxyClient.hasEndpoint(prop)) {
                    throw new Error(
                        `No @PubSub endpoint '${prop}' on ${apiClass.name || 'Unknown'}. ` +
                        `Check for typos or a missing @Endpoint() decorator.`,
                    );
                }
                // webpieces-disable no-any-unknown -- request DTO type is erased at the proxy layer
                return (requestDto: unknown): Promise<void> => proxyClient.enqueue(prop, requestDto);
            },
        });
    }
}
