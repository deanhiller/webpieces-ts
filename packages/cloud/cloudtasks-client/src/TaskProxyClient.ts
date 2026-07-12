import { inject, injectable } from 'inversify';
import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMode,
    getQueueName,
    assertPubSubConventions,
    assertEveryEndpointHasAuthMode,
    AuthMode,
    LogManager,
} from '@webpieces/core-util';
import {
    RequestContextHeaders,
    provideFrameworkTransient,
} from '@webpieces/core-context';
import { TaskInvoker, TaskRequest, ScheduleInfo } from './TaskTypes';
import { currentScheduleFrame } from './ScheduleContext';
import { ApiPrototype, TaskClientConfig } from './TaskClientConfig';

const log = LogManager.getLogger('TaskProxyClient');

/** Per-endpoint routing plan resolved once from the contract's decorators. */
class EndpointPlan {
    path: string;
    queueName: string;
    authMode: AuthMode;

    constructor(path: string, queueName: string, authMode: AuthMode) {
        this.path = path;
        this.queueName = queueName;
        this.authMode = authMode;
    }
}

/**
 * TaskProxyClient - the enqueue engine behind one @PubSub API contract's client proxy.
 *
 * The fire-and-forget twin of http-client-core's ProxyClient, and TWO-PHASE for the same reason:
 * its COLLABORATORS (invoker, headers) come from the container, while the PER-CLIENT state (which
 * contract, which target) arrives on {@link init}. That is what lets {@link ClientCloudTasksFactory}
 * hold a `Provider<TaskProxyClient>` and hand out a fresh, independently-configured client per
 * contract.
 *
 * Calling an endpoint ENQUEUES a task (it does not call remotely); the task is later delivered to
 * the same endpoint's controller through the full server filter chain.
 *
 * It owns:
 * - @ApiPath / @PubSub convention validation + the endpoint plans from the contract's decorators
 * - Resolving the callee's base URL from svcName (ClientRegistry override, else GCP derivation)
 * - Context propagation onto the task headers (a credential is never a context key, so none can ride along)
 * - Handing a fully-built TaskRequest to the bound {@link TaskInvoker}
 */
@provideFrameworkTransient()
@injectable()
export class TaskProxyClient {
    // Assigned by init(), which the factory calls immediately after construction.
    private plans!: Map<string, EndpointPlan>;
    private apiName!: string;
    private config!: TaskClientConfig;

    constructor(
        @inject(TaskInvoker) private readonly invoker: TaskInvoker,
        @inject(RequestContextHeaders) private readonly headers: RequestContextHeaders,
    ) {}

    /** Bind this client to one @PubSub contract + target. */
    init(apiClass: ApiPrototype<object>, config: TaskClientConfig): void {
        if (!isApiPath(apiClass)) {
            throw new Error(`Class ${apiClass.name || 'Unknown'} must be decorated with @ApiPath()`);
        }
        assertPubSubConventions(apiClass);
        assertEveryEndpointHasAuthMode(apiClass);

        this.config = config;
        this.apiName = apiClass.name || 'UnknownApi';
        this.plans = this.buildPlans(apiClass);
    }

    /** Check whether the contract declares a @PubSub endpoint with this method name. */
    hasEndpoint(methodName: string): boolean {
        return this.plans.has(methodName);
    }

    /**
     * Enqueue one task for the named endpoint. Must run inside a CloudTaskScheduler lambda
     * (which supplies the ScheduleInfo) within an active RequestContext, e.g.:
     *   scheduler.addToQueue(() => taskClient.foo(req), { dedupName });
     */
    // webpieces-disable no-any-unknown -- the request DTO's type is erased at the proxy boundary
    async enqueue(methodName: string, requestDto: unknown): Promise<void> {
        const plan = this.plans.get(methodName);
        if (!plan) {
            throw new Error(`No @PubSub endpoint '${methodName}' on ${this.apiName}`);
        }

        const frame = currentScheduleFrame();
        if (!frame) {
            throw new Error(
                'Cloud task enqueue must run inside a CloudTaskScheduler lambda, e.g. ' +
                'scheduler.addToQueue(() => taskClient.method(req), { dedupName }).',
            );
        }

        // Resolved lazily (not at client construction) so building a client stays synchronous.
        // Every metadata read beneath resolveServiceUrl is memoized process-wide, so only the
        // first enqueue in the process pays a lookup.
        const targetUrl = await this.config.resolveUrl();

        const request = new TaskRequest(
            targetUrl,
            plan.path,
            plan.queueName,
            requestDto,
            this.buildContextHeaders(),
            plan.authMode,
            frame.info ?? new ScheduleInfo(),
        );

        // svcName, not the URL, is the stable name across demo/qa/prod.
        log.debug(`enqueue task ${plan.queueName} -> ${this.config.svcName}${plan.path}`);
        frame.jobRef = await this.invoker.enqueue(request);
    }

    /** Endpoint name -> its resolved path / queue / auth mode, read once from the decorators. */
    private buildPlans(apiClass: ApiPrototype<object>): Map<string, EndpointPlan> {
        const basePath = getApiPath(apiClass) ?? '';
        const endpoints = getEndpoints(apiClass) ?? {};
        const plans = new Map<string, EndpointPlan>();

        for (const methodName of Object.keys(endpoints)) {
            const authMode = getAuthMode(apiClass, methodName);
            if (!authMode) {
                throw new Error(`Endpoint '${methodName}' on ${this.apiName} has no auth mode`);
            }
            const plan = new EndpointPlan(
                basePath + endpoints[methodName],
                getQueueName(apiClass, methodName),
                authMode,
            );
            plans.set(methodName, plan);
        }
        return plans;
    }

    /**
     * Every transferred context key (txId/requestId/tenant…), request-id chained.
     * Throws if there is no active RequestContext — an enqueue with no trace is a bug.
     *
     * No credential can appear here: `authorization` is read off the inbound HttpRequest and is not
     * a ContextKey, so it never enters the RequestContext to be transferred. The invoker mints the
     * task's own delivery auth per the endpoint's @AuthOidc / @AuthSharedSecret mode.
     */
    private buildContextHeaders(): Map<string, string> {
        return this.headers.buildOutboundHeaders();
    }
}

/**
 * DI token for the `Provider<TaskProxyClient>` that hands out enqueue clients — one per @PubSub
 * contract. `Provider<T>` is erased at runtime, so it cannot be its own token; this Symbol names T.
 *
 * Because TaskProxyClient is bound TRANSIENT, every `get()` constructs a new one. (Were it bound
 * `@provideFrameworkSingleton`, the very same Provider would hand back one lazily-created instance
 * instead — the provider caches nothing, so the target's scope decides.)
 */
// webpieces-disable no-symbol-di-tokens -- Provider<T> is erased at runtime; the Symbol names T
export const TASK_PROXY_CLIENT_PROVIDER = Symbol.for('Provider<TaskProxyClient>');
