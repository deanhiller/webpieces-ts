import 'reflect-metadata';
import { EndpointKind, METADATA_KEYS, getEndpoints, getEndpointKinds, isApiPath } from './decorators';

/**
 * API KIND — whether a contract is synchronous RPC or fire-and-forget over a queue — plus the
 * queue-naming rules that only a @PubSub contract has.
 *
 * Split out of `decorators.ts` purely for size (max-file-lines); the dependency runs ONE way,
 * api-kind -> decorators, so there is no cycle. Auth modes and endpoint shape stay in
 * `decorators.ts`; everything here is re-exported from the package barrel, so no consumer import
 * changes and there is no second spelling of anything.
 */

// ============================================================
// API kind (RPC vs PubSub/Cloud Tasks) + queue naming
// ============================================================

/**
 * API kind. 'rpc' = synchronous request/response (http-client ↔ ApiRoutingFactory).
 * 'pubsub' = fire-and-forget cloud task; the enqueue client (cloudtasks-client)
 * schedules a Cloud Task that is later delivered to the SAME controller endpoint.
 */
export type ApiKind = 'rpc' | 'pubsub';

/**
 * @Rpc() - marks an API class as synchronous request/response (the default kind).
 * Present mostly for symmetry/readability; an undecorated API is treated as 'rpc'.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function Rpc(): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_KIND, 'rpc' as ApiKind, target);
    };
}

/**
 * @PubSub() - marks an API class as fire-and-forget over Cloud Tasks. Every method
 * MUST return Promise<void> (a compile-time contract on the abstract API). The
 * enqueue client and the controller share this one class, exactly like RPC.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function PubSub(): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_KIND, 'pubsub' as ApiKind, target);
    };
}

/**
 * @Queue(name) - override the Cloud Tasks queue name for a @PubSub method. Default
 * (no decorator) is `${ApiClassName}-${methodName}`, matched 1:1 by Terraform.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function Queue(name: string): MethodDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const overrides: Record<string, string> =
            Reflect.getMetadata(METADATA_KEYS.QUEUE_OVERRIDE, metadataTarget) || {};
        overrides[propertyKey as string] = name;
        Reflect.defineMetadata(METADATA_KEYS.QUEUE_OVERRIDE, overrides, metadataTarget);
    };
}

/**
 * Get the API kind. Defaults to 'rpc' when neither @Rpc nor @PubSub is present.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function getApiKind(apiClass: Function): ApiKind {
    return (Reflect.getMetadata(METADATA_KEYS.API_KIND, apiClass) as ApiKind) ?? 'rpc';
}

/**
 * Assert the API class is of the expected kind (used by the clients: the RPC
 * client rejects a @PubSub api and vice-versa).
 * @throws Error if the kind doesn't match.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function assertApiKind(apiClass: Function, expected: ApiKind): void {
    const actual = getApiKind(apiClass);
    if (actual !== expected) {
        const apiName = apiClass.name || 'Unknown';
        throw new Error(
            `API ${apiName} is @${actual === 'pubsub' ? 'PubSub' : 'Rpc'} but a ` +
            `${expected === 'pubsub' ? '@PubSub (cloud task)' : '@Rpc'} API was required here.`,
        );
    }
}

/**
 * Which {@link EndpointKind}s each {@link ApiKind} may declare. A @PubSub contract is delivered
 * asynchronously by definition, so `rpc` is meaningless on it; an @Rpc contract has no queue, so
 * `cloudtasks`/`cron` on it would name a queue/schedule nothing could ever deliver to. `external`
 * is legal on both — a webhook posts synchronously, a push subscription does not.
 *
 * Shared so the wiring-time assert below and the build-time architecture scan enforce ONE rule.
 */
export const ENDPOINT_KINDS_BY_API_KIND: Record<ApiKind, readonly EndpointKind[]> = {
    rpc: ['rpc', 'external'],
    pubsub: ['cloudtasks', 'cron', 'external'],
};

/**
 * Validate @PubSub conventions at wiring time: the class must be @ApiPath + @PubSub, declare at
 * least one endpoint, and every endpoint must declare a kind this api kind can actually deliver.
 * (Return-type is Promise<void>, a compile-time contract — TS erases types at runtime so it cannot
 * be re-checked here.)
 * @throws Error if conventions are violated.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function assertPubSubConventions(apiClass: Function): void {
    assertApiKind(apiClass, 'pubsub');
    const apiName = apiClass.name || 'Unknown';
    if (!isApiPath(apiClass)) {
        throw new Error(`@PubSub API ${apiName} must also be decorated with @ApiPath()`);
    }
    const endpoints = getEndpoints(apiClass) || {};
    if (Object.keys(endpoints).length === 0) {
        throw new Error(`@PubSub API ${apiName} declares no @Endpoint methods`);
    }
    const allowed = ENDPOINT_KINDS_BY_API_KIND.pubsub;
    const kinds = getEndpointKinds(apiClass);
    for (const methodName of Object.keys(endpoints)) {
        const kind = kinds[methodName];
        if (kind !== undefined && allowed.includes(kind)) continue;
        throw new Error(
            `@PubSub API ${apiName}.${methodName} declares @Endpoint(..., '${kind ?? 'missing'}') — a ` +
            `@PubSub contract is delivered through a queue, so it must be one of: ${allowed.join(' | ')}.`,
        );
    }
}

/**
 * Resolve the Cloud Tasks queue name for a @PubSub method: the @Queue override if
 * present, else `${ApiClassName}-${methodName}`.
 */
// webpieces-disable no-function-outside-class -- decorator factory / reflect-metadata reader; moved verbatim from decorators.ts for file size, same module-scope shape as its siblings there
export function getQueueName(apiClass: Function, methodName: string): string {
    const overrides: Record<string, string> =
        Reflect.getMetadata(METADATA_KEYS.QUEUE_OVERRIDE, apiClass) || {};
    return overrides[methodName] ?? `${apiClass.name || 'Unknown'}-${methodName}`;
}
