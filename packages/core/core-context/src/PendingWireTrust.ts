import { AnyTrustedContextKey } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * Reserved (deliberately UNREGISTERED) slot holding the pending map. Not a ContextKey: it is
 * framework plumbing that exists only between the inbound fill and the AuthFilter, and giving it a
 * ContextKey would make it transferrable/loggable, neither of which it should ever be.
 */
const PENDING_WIRE_TRUST_KEY = '__webpieces_pending_wire_trust__';

/**
 * One trusted key that ARRIVED ON THE WIRE and has not yet been vouched for. Data-only (a class,
 * per the guidelines). Carries the key as well as the value so a rejection message can name the
 * HTTP header the caller actually sent, not just the context name.
 */
export class PendingTrustedValue {
    constructor(
        public readonly key: AnyTrustedContextKey,
        public readonly value: string,
    ) {}
}

/**
 * PendingWireTrust - the holding pen between "a trusted key arrived on the wire" and "we know
 * whether we may believe it".
 *
 * ## The hole this closes
 *
 * `RequestContextHeaders.fillFromRequest` runs at the TRANSPORT level (`ExpressWrapper`), and
 * `AuthFilter` runs later, as a filter. So the wire always gets to write first and the authenticator
 * second. If the inbound loop wrote trusted keys straight into the context, then for the entire
 * window before AuthFilter ran — and forever after, on any route where the authenticator does not
 * happen to stamp that particular key — a value typed by whoever sent the request would be sitting
 * in the slot that `getTrusted` reads. `curl -H 'x-user-id: victim'` would be an authenticated
 * identity.
 *
 * That is not hypothetical on this codebase: the framework's own {@link DefaultJwtHook} returns an
 * EMPTY `AuthenticatedCaller.entries`, so a fully verified `@AuthJwt` request stamps no context entries at
 * all and would leave a forged `x-user-id` completely unopposed.
 *
 * ## The fix
 *
 * Inbound trusted values never enter the context. They are stashed HERE, and `AuthFilter` decides
 * what to do with them once it knows who the caller is:
 *
 * - `@AuthOidc` / `@AuthSharedSecret` — the CALLER's own identity was verified, so this is an
 *   internal service passing along context it already holds. Admit the pending values as trusted.
 *   This is what makes service-to-service propagation of a verified userId work, and it is the whole
 *   reason trusted keys are allowed to have an `httpHeader` at all.
 * - `@AuthJwt` / public — the caller may be a browser or anyone with curl. A pending value is
 *   admitted ONLY if the authenticator independently derived the SAME value. Anything else — a
 *   different value, or a value nothing vouched for — rejects the request.
 *
 * Note the deliberate asymmetry with a "strip it and carry on" design: a mismatch is not merely
 * neutralized, it FAILS. Rate limiters commonly bucket on the inbound header rather than on the JWT,
 * so a request whose header says `alice` and whose JWT says `bob` was rate-limited as the wrong
 * principal. Letting the JWT quietly win would turn every forged header into a free rate-limit
 * bypass. There is no legitimate caller that sends a header contradicting its own credential.
 *
 * ## If nothing reconciles
 *
 * `AuthFilter` is auto-installed on every route, so reconciliation always happens on a webpieces
 * server. Should a non-webpieces transport ever call `fillFromRequest` without one, the pending
 * values simply never arrive — the trusted key reads as absent. That is the fail-SAFE direction, and
 * it is intentional: silence beats an unvouched value.
 *
 * Module-global instance (like {@link RequestContext} itself) rather than a DI singleton — it is
 * stateless plumbing over the ambient context, used by one class on each side of the boundary.
 */
class PendingWireTrustImpl {
    /**
     * Hold an inbound wire value for a trusted key. Called by the inbound fill INSTEAD of writing it
     * into the context.
     */
    stash(key: AnyTrustedContextKey, value: string): void {
        const pending = this.current() ?? new Map<string, PendingTrustedValue>();
        pending.set(key.name, new PendingTrustedValue(key, value));
        RequestContext.put(PENDING_WIRE_TRUST_KEY, pending);
    }

    /**
     * Everything stashed for this request, and CLEAR the pen in the same step — so reconciliation
     * cannot run twice and a value cannot be re-admitted later by anything else.
     */
    takeAll(): PendingTrustedValue[] {
        const pending = this.current();
        if (!pending) {
            return [];
        }
        RequestContext.remove(PENDING_WIRE_TRUST_KEY);
        return Array.from(pending.values());
    }

    private current(): Map<string, PendingTrustedValue> | undefined {
        return RequestContext.get<Map<string, PendingTrustedValue>>(PENDING_WIRE_TRUST_KEY);
    }
}

/** The process-wide holding pen. See {@link PendingWireTrustImpl}. */
export const PendingWireTrust = new PendingWireTrustImpl();
