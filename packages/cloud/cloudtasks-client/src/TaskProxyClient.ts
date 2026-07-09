import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMode,
    getQueueName,
    assertPubSubConventions,
    assertEveryEndpointHasAuthMode,
    AuthMode,
    DocumentDesign,
    LogManager,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-context';
import { getCloudRunUrl } from '@webpieces/gcp-identity';
import { TaskInvoker, TaskRequest, ScheduleInfo } from './TaskTypes';
import { currentScheduleFrame } from './ScheduleContext';
import { ApiPrototype, TaskClientConfig } from './TaskClientConfig';

const log = LogManager.getLogger('TaskProxyClient');

/**
 * Auth headers are NEVER propagated from the caller's context onto an enqueued task:
 * the caller's inbound user JWT / secret must not leak to an internal service, and
 * the invoker mints fresh delivery auth (OIDC / shared-secret) per the endpoint's mode.
 */
const AUTH_HEADER_NAMES = new Set<string>(['authorization', 'x-webpieces-shared-secret']);

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
 * The fire-and-forget twin of http-client's ProxyClient, and the @DocumentDesign design
 * root for this package: its constructor params ARE the enqueue client's dependency graph.
 * Built by {@link ClientCloudTasksFactory} (one per API contract), it owns:
 * - @ApiPath / @PubSub convention validation + the endpoint plans from the contract's decorators
 * - Resolving the callee's Cloud Run base URL from the service name
 * - Context propagation onto the task headers (MINUS the caller's auth headers)
 * - Handing a fully-built TaskRequest to the bound {@link TaskInvoker}
 *
 * Calling an endpoint ENQUEUES a task (it does not call remotely); the task is later
 * delivered to the same endpoint's controller through the full server filter chain.
 */
@DocumentDesign()
export class TaskProxyClient {
    private plans: Map<string, EndpointPlan>;
    private apiName: string;

    constructor(
        apiClass: ApiPrototype<object>,
        private config: TaskClientConfig,
        private invoker: TaskInvoker,
        private contextMgr: ContextMgr,
    ) {
        if (!isApiPath(apiClass)) {
            throw new Error(`Class ${apiClass.name || 'Unknown'} must be decorated with @ApiPath()`);
        }
        assertPubSubConventions(apiClass);
        assertEveryEndpointHasAuthMode(apiClass);

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
        // Every metadata read beneath getCloudRunUrl is memoized process-wide, so only the
        // first enqueue in the process pays a lookup.
        const targetUrl = await getCloudRunUrl(this.config.gcpCloudRunSvcName);

        const request = new TaskRequest(
            targetUrl,
            plan.path,
            plan.queueName,
            requestDto,
            this.buildContextHeaders(),
            plan.authMode,
            frame.info ?? new ScheduleInfo(),
        );

        log.debug(`enqueue task ${plan.queueName} -> ${targetUrl}${plan.path}`);
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

    /** Transferred context keys (txId/requestId/tenant…) MINUS the caller's auth credentials. */
    private buildContextHeaders(): Map<string, string> {
        const headers = new Map<string, string>();
        for (const entry of this.contextMgr.buildOutboundHeaders().entries()) {
            if (!AUTH_HEADER_NAMES.has(entry[0].toLowerCase())) {
                headers.set(entry[0], entry[1]);
            }
        }
        return headers;
    }
}
