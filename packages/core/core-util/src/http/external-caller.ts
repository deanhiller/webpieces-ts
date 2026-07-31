/**
 * WHO calls us from outside — the vocabulary an `external` @Endpoint uses to name its caller.
 *
 * Deliberately the SAME `(kind, label)` vocabulary the runtime architecture graph already uses for
 * OUTBOUND vendor seams (`@externalSystem saas twilio`). An inbound `saas twilio` and an outbound
 * `saas twilio` are the same vendor, so sharing the vocabulary makes them share an IDENTITY and
 * converge on ONE node instead of drawing twilio twice, facing opposite directions.
 *
 * Its own module rather than a block in decorators.ts: this is a data model with no dependency on
 * anything in that file, and decorators.ts is near its file-size limit. The dependency is strictly
 * one-way (decorators.ts imports this; this imports only reflect-metadata), so no cycle is possible.
 *
 * ## MIGRATION (breaking, 0.5.x)
 *
 * `calledBy` is REQUIRED on every `external` endpoint — `@Endpoint(path, 'external', options)` no
 * longer compiles without it. That is the point: a lint rule can be ignored, a compile error cannot,
 * and the alternative was a graph that names our own contract where the vendor belongs. One property
 * per endpoint migrates it:
 *
 * ```ts
 * // before
 * @Endpoint('/inbound', 'external', { formPost: true })
 * // after
 * @Endpoint('/inbound', 'external', { formPost: true, calledBy: 'twilio' })
 * // infrastructure rather than a vendor product:
 * @Endpoint('/push', 'external', { calledBy: 'pubsub-push', callerKind: 'system' })
 * ```
 *
 * Nothing else changes: `rpc` / `cloudtasks` / `cron` endpoints keep their exact signature, options
 * stay optional there, and the ENDPOINTS path map every consumer iterates is untouched.
 */

import 'reflect-metadata';

/**
 * What KIND of system an external caller IS. Drives the shape the runtime graph draws it with, so a
 * push-subscription stops looking like a vendor SaaS.
 *
 * Most inbound webhooks are `saas` (Twilio, Gmail, Stripe). A GCP Pub/Sub push subscription is
 * `system` — it is infrastructure, not a vendor product.
 */
export const EXTERNAL_SYSTEM_KINDS = ['database', 'cache', 'queue', 'storage', 'saas', 'system'] as const;

export type ExternalSystemKind = (typeof EXTERNAL_SYSTEM_KINDS)[number];

/** True for a string that names one of {@link EXTERNAL_SYSTEM_KINDS}. */
// webpieces-disable no-function-outside-class -- type guard beside the type it guards
export function isExternalSystemKind(value: string): value is ExternalSystemKind {
    return (EXTERNAL_SYSTEM_KINDS as readonly string[]).includes(value);
}

/**
 * The declared caller of ONE `external` endpoint, normalized: `callerKind` defaulted, `calledBy`
 * carried as the label.
 *
 * `label` is the node IDENTITY on the runtime graph, not merely display text — two endpoints
 * declaring `twilio` converge on one box with two arrows into it.
 */
export class ExternalCaller {
    constructor(
        public readonly kind: ExternalSystemKind,
        public readonly label: string,
    ) {}
}

/** The kind an `external` @Endpoint gets when it declares `calledBy` but no `callerKind`. */
export const DEFAULT_CALLER_KIND: ExternalSystemKind = 'saas';

/**
 * Metadata key of the per-method caller map, `methodName -> ExternalCaller`. Parallel to ENDPOINTS,
 * exactly like ENDPOINT_KIND and ENDPOINT_OPTIONS, and re-exported as `METADATA_KEYS.ENDPOINT_CALLER`
 * — declared HERE so the reader below needs no import from decorators.ts (which would close a cycle).
 */
export const ENDPOINT_CALLER_KEY = 'webpieces:endpoint-caller';

/**
 * The DECLARED caller of one method, or undefined when it is not `external` (or is `external` but
 * bypassed TS — see `assertEveryExternalEndpointDeclaresCaller`). Mirrors `getEndpointOptions`.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointOptions
export function getEndpointCaller(apiClass: Function, methodName: string): ExternalCaller | undefined {
    const callers: Record<string, ExternalCaller> = Reflect.getMetadata(ENDPOINT_CALLER_KEY, apiClass) || {};
    return callers[methodName];
}
