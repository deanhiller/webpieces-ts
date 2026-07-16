import { inject } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { Provider, bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import { TASK_PROXY_CLIENT_PROVIDER, TaskProxyClient } from './TaskProxyClient';
import { ApiPrototype, TaskClientConfig } from './TaskClientConfig';

// Teach the container how to hand out fresh TaskProxyClients. TaskProxyClient is bound TRANSIENT
// (@provideFrameworkTransient), so each provider.get() constructs a new one.
bindFrameworkProvider(TASK_PROXY_CLIENT_PROVIDER, TaskProxyClient);

/**
 * Properties DI frameworks / Promise checks / serializers probe on the proxy; return
 * undefined instead of treating them as endpoints. Mirrors http-client-core's buildClientProxy.
 */
const FRAMEWORK_INSPECTION_PROPERTIES = new Set<string>([
    'constructor', 'prototype', '__proto__', 'name', 'then', 'catch', 'finally',
    'toJSON', 'valueOf', 'toString', 'nodeType', 'tagName', '$$typeof',
]);

/**
 * ClientCloudTasksFactory - builds Cloud Tasks enqueue clients from a shared @PubSub API
 * contract. The fire-and-forget twin of http-client-node's ClientHttpFactory.
 *
 * Calling a method on the returned client ENQUEUES a task (it does not call remotely); the task
 * is later delivered to the same endpoint's controller through the full server filter chain.
 *
 * ```typescript
 * // same project + region as this container; the URL is derived, you maintain nothing
 * const emailTasks = factory.createPubSubClient(EmailApi, new TaskClientConfig('email-svc'));
 * await scheduler.addToQueue(() => emailTasks.sendEmail(req), { dedupName });
 * ```
 *
 * Every client it builds gets its OWN {@link TaskProxyClient} from the injected
 * `Provider<TaskProxyClient>` (bound transient), which `createPubSubClient` then `init`s for one
 * contract. Their collaborators (TaskInvoker, RequestContextHeaders) come from the container.
 *
 * Node-only, so the factory IS the inversify entry point. An enqueue outside
 * `RequestContext.run(...)` throws rather than silently dropping the caller's trace.
 */
@DocumentDesign()
@provideFrameworkSingleton()
export class ClientCloudTasksFactory {
    constructor(
        @inject(TASK_PROXY_CLIENT_PROVIDER) private readonly taskProxyClientProvider: Provider<TaskProxyClient>,
    ) {}

    /** Typed enqueue client for a @PubSub contract, delivered to `config.svcName`. */
    createPubSubClient<T extends object>(apiClass: ApiPrototype<T>, config: TaskClientConfig): T {
        // Fresh instance per contract — TaskProxyClient is transient.
        const proxyClient = this.taskProxyClientProvider.get();
        proxyClient.init(apiClass, config);

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
