import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMode,
    getQueueName,
    assertPubSubConventions,
    assertEveryEndpointHasAuthMode,
    AuthMode,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-context';
import { LogManager } from '@webpieces/core-util';
import { TaskInvoker, TaskRequest, ScheduleInfo } from './TaskTypes';
import { currentScheduleFrame } from './ScheduleContext';

const log = LogManager.getLogger('TaskClientFactory');

/** Constructor whose prototype is T (the abstract API class). */
type ApiPrototype<T> = Function & { prototype: T };

/**
 * Auth headers are NEVER propagated from the caller's context onto an enqueued task:
 * the caller's inbound user JWT / secret must not leak to an internal service, and
 * the invoker mints fresh delivery auth (OIDC / shared-secret) per the endpoint's mode.
 */
const AUTH_HEADER_NAMES = new Set<string>(['authorization', 'x-webpieces-shared-secret']);

/**
 * Properties DI frameworks / Promise checks / serializers probe on the proxy; return
 * undefined instead of treating them as endpoints. Mirrors http-client's ClientFactory.
 */
const FRAMEWORK_INSPECTION_PROPERTIES = new Set<string>([
    'constructor', 'prototype', '__proto__', 'name', 'then', 'catch', 'finally',
    'toJSON', 'valueOf', 'toString', 'nodeType', 'tagName', '$$typeof',
]);

/** Configuration for an enqueue client. */
export class TaskClientConfig {
    /** Callee base URL, or an async resolver (e.g. getCloudRunUrl(serviceName)). */
    targetUrl: string | (() => Promise<string>);
    /** The transport that enqueues the task (GcpTaskInvoker / InMemoryTaskInvoker). */
    invoker: TaskInvoker;
    /** Optional context propagation (txId/requestId/tenant…) onto the task headers. */
    contextMgr?: ContextMgr;

    constructor(
        targetUrl: string | (() => Promise<string>),
        invoker: TaskInvoker,
        contextMgr?: ContextMgr,
    ) {
        this.targetUrl = targetUrl;
        this.invoker = invoker;
        this.contextMgr = contextMgr;
    }
}

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
 * Create a Cloud Tasks enqueue client from a shared @PubSub API contract. Calling a
 * method ENQUEUES a task (it does not call remotely); the task is later delivered to
 * the same endpoint's controller through the full server filter chain.
 *
 * Must be called inside a CloudTaskScheduler lambda (which supplies the ScheduleInfo)
 * within an active RequestContext, e.g.:
 *   scheduler.addToQueue(() => taskClient.foo(req), { dedupName });
 */
export function createTaskClient<T extends object>(
    apiClass: ApiPrototype<T>,
    config: TaskClientConfig,
): T {
    if (!isApiPath(apiClass)) {
        throw new Error(`Class ${apiClass.name || 'Unknown'} must be decorated with @ApiPath()`);
    }
    assertPubSubConventions(apiClass);
    assertEveryEndpointHasAuthMode(apiClass);

    const basePath = getApiPath(apiClass) ?? '';
    const endpoints = getEndpoints(apiClass) ?? {};
    const plans = buildPlans(apiClass, basePath, endpoints);

    return new Proxy({} as T, {
        // webpieces-disable no-any-unknown -- proxy get trap returns either a method or undefined
        get(_target: T, prop: string | symbol): unknown {
            if (typeof prop !== 'string' || FRAMEWORK_INSPECTION_PROPERTIES.has(prop)) {
                return undefined;
            }
            const plan = plans.get(prop);
            if (!plan) {
                throw new Error(
                    `No @PubSub endpoint '${prop}' on ${apiClass.name || 'Unknown'}. ` +
                    `Check for typos or a missing @Endpoint() decorator.`,
                );
            }
            // webpieces-disable no-any-unknown -- request DTO type is erased at the proxy layer
            return (requestDto: unknown): Promise<void> => enqueue(config, plan, requestDto);
        },
    });
}

function buildPlans(
    apiClass: Function,
    basePath: string,
    endpoints: Record<string, string>,
): Map<string, EndpointPlan> {
    const plans = new Map<string, EndpointPlan>();
    for (const methodName of Object.keys(endpoints)) {
        const authMode = getAuthMode(apiClass, methodName);
        if (!authMode) {
            throw new Error(`Endpoint '${methodName}' on ${apiClass.name} has no auth mode`);
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

async function enqueue(
    config: TaskClientConfig,
    plan: EndpointPlan,
    // webpieces-disable no-any-unknown -- request DTO type is erased at the proxy layer
    requestDto: unknown,
): Promise<void> {
    const frame = currentScheduleFrame();
    if (!frame) {
        throw new Error(
            'Cloud task enqueue must run inside a CloudTaskScheduler lambda, e.g. ' +
            'scheduler.addToQueue(() => taskClient.method(req), { dedupName }).',
        );
    }

    const targetUrl = typeof config.targetUrl === 'string'
        ? config.targetUrl
        : await config.targetUrl();

    const contextHeaders = buildContextHeaders(config.contextMgr);

    const request = new TaskRequest(
        targetUrl,
        plan.path,
        plan.queueName,
        requestDto,
        contextHeaders,
        plan.authMode,
        frame.info ?? new ScheduleInfo(),
    );

    log.debug(`enqueue task ${plan.queueName} -> ${targetUrl}${plan.path}`);
    frame.jobRef = await config.invoker.enqueue(request);
}

function buildContextHeaders(contextMgr?: ContextMgr): Map<string, string> {
    const headers = new Map<string, string>();
    if (!contextMgr) {
        return headers;
    }
    for (const entry of contextMgr.buildOutboundHeaders().entries()) {
        if (!AUTH_HEADER_NAMES.has(entry[0].toLowerCase())) {
            headers.set(entry[0], entry[1]);
        }
    }
    return headers;
}
