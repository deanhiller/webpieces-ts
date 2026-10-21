import { AnyContextKey } from '../ContextKey';
import { AuthMode } from './auth-mode';
import { RouteMetadata } from './RouteMetadata';

/**
 * DestinationTrust - the OUTBOUND half of the trust model: may a TRUSTED context key
 * ({@link ContextKey.trusted}) ride to the endpoint we are about to call?
 *
 * ## Why the client has to answer this at all
 *
 * The server already decided (see `PendingWireTrust`): an inbound `x-user-id` is admitted only on a
 * route that verified WHO called it — `oidcSameProject()` / `oidcSvcs(...)` / `sharedSecret(...)`. On a `jwt()` or `@WpAuthPublic`
 * route the same header must match what the authenticator independently derived, or the request is
 * REJECTED with a 401.
 *
 * That rule is correct, and it means a client that ships `x-user-id` to a `@WpAuthPublic` endpoint is
 * building a request the callee is obliged to reject. Before this class the outbound builders
 * forwarded EVERY transferred key with no idea what the destination was, so an internal service
 * calling another service's public or JWT endpoint 401'd itself. The fix belongs on the producing
 * side: don't send what cannot possibly be believed.
 *
 * ## Why it is a class with a private constructor and no boolean parameter
 *
 * `buildOutboundHeaders(sendTrusted = true)` would have been three characters of work and exactly the
 * "widening that is an ABSENCE rather than a token" `.claude/rules/no-backwards-compat.md` rejects — the
 * permissive answer would be
 * what you get by not typing anything. There is no way to build a DestinationTrust except from the
 * destination endpoint's own {@link AuthMode}, so the caller cannot assert a posture the route does
 * not actually have, and `grep -rn DestinationTrust.forAuthMode` lists every place the question is
 * asked. The two instances are PRIVATE for the same reason: exposing them would be a second spelling
 * that skips the derivation.
 *
 * Per CLAUDE.md: data-only structure, so a class rather than an interface or a bare boolean.
 */
export class DestinationTrust {
    /**
     * The destination authenticates its CALLER (oidcSameProject() / oidcSvcs(...) / sharedSecret(...)), so it is entitled to
     * believe context WE vouch for — this is the service-to-service identity propagation that trusted
     * keys keep an `httpHeader` for.
     */
    private static readonly VERIFIES_CALLER = new DestinationTrust(true, undefined);

    /**
     * The destination cannot tell us from a browser with curl (jwt() / @WpAuthPublic / vendorAuth(...) /
     * apiKey(...) / @WpLocalOnly / an endpoint with no declared mode), so trusted keys are omitted.
     * Untrusted keys still travel.
     */
    private static readonly CANNOT_VERIFY_CALLER = new DestinationTrust(false, undefined);

    private constructor(
        private readonly verifiesCaller: boolean,
        /**
         * Set ONLY for an `EXTERNAL_OUTBOUND` destination: the `@ExternalContextKeys` list, which is
         * then the WHOLE of what may be sent. Undefined for every destination in this repo, whose wire
         * is governed by {@link forAuthMode} exactly as before.
         */
        private readonly externalKeys: readonly AnyContextKey[] | undefined,
    ) {}

    /**
     * The destination of ONE route. An `EXTERNAL_OUTBOUND` route (an outside system's API) gets a
     * destination that sends ONLY its `@ExternalContextKeys` and believes NO response header: a vendor
     * is somebody else's process, so our `x-request-id`, `x-webpieces-*` and app keys stay home unless
     * the contract lists them, and nothing it answers may write into our context. Every other route is
     * {@link forAuthMode}, unchanged — so the wire to our own servers is identical.
     */
    // webpieces-disable no-function-outside-class -- static factory beside forAuthMode, for the same reason
    static forRoute(route: RouteMetadata): DestinationTrust {
        if (route.externalOutbound) {
            return new DestinationTrust(false, route.externalContextKeys);
        }
        return DestinationTrust.forAuthMode(route.authMeta?.methods[0]);
    }

    /**
     * The keys an `EXTERNAL_OUTBOUND` destination sends — every one is REQUIRED, so a builder throws
     * before any I/O when one has no value. Undefined for every other destination, whose builder
     * iterates the registry's transferred keys and filters them with {@link allows}.
     */
    listedKeys(): readonly AnyContextKey[] | undefined {
        return this.externalKeys;
    }

    /**
     * The ONLY way to obtain one: state the destination endpoint's auth mode. `undefined` (an
     * endpoint that declared no mode) is treated as un-verifying, i.e. the SAFE answer — an absent
     * declaration must never be the widest one.
     */
    // webpieces-disable no-function-outside-class -- static factory replacing the (now private) constructor, exactly as ContextKey.trusted/untrusted do: the destination's auth mode must be part of the CALL, and a DI-injected instance method would let a caller hold one without ever naming a route
    static forAuthMode(mode: AuthMode | undefined): DestinationTrust {
        if (mode === undefined) {
            return DestinationTrust.CANNOT_VERIFY_CALLER;
        }
        switch (mode.kind) {
            case 'oidc':
            case 'shared-secret':
                return DestinationTrust.VERIFIES_CALLER;
            case 'jwt':
            case 'public':
            // vendorAuth(...) authenticates an OUTSIDE VENDOR, which is not the same thing as
            // authenticating a peer in this repo. The vendor knows nothing of webpieces context
            // headers and would never send one, so there is no identity to propagate in either
            // direction. Trusted keys stay home.
            case 'vendorAuth':
            // apiKey(...) authenticates a CUSTOMER, not a peer service. The holder of the key is
            // another company's codebase, so nothing it forwards may be believed, and no webpieces
            // client can call it anyway (the framework extracts no api-key header — the app's hook
            // owns which headers carry the credential; the contract's `credentials` list only DESCRIBES
            // them). Trusted keys stay home.
            case 'apikey':
            // @WpLocalOnly authenticates NOBODY — it gates on the environment, not on a
            // credential — so a browser with curl on the same laptop is indistinguishable from us.
            // Same bucket as public/jwt. (This switch has NO `default` on purpose: adding a kind to
            // AuthMode is a compile error here rather than a silent permissive fallthrough.)
                return DestinationTrust.CANNOT_VERIFY_CALLER;
        }
    }

    /**
     * May this key cross the boundary between us and this destination? Untrusted keys always may —
     * nobody was ever going to make a security decision on them. A trusted key may only when we and
     * the destination authenticate each other.
     *
     * ONE method answers BOTH directions, deliberately, because it is one question:
     *
     * - OUTBOUND (`buildOutboundHeaders`): may we SEND a trusted key there? Only when the destination
     *   will authenticate US, because that is the only case its `AuthFilter` will admit it.
     * - RESPONSE (`acceptResponseHeaders`): may we BELIEVE a trusted key that came BACK? Only from a
     *   destination this client authenticated to — an `oidcSameProject()` / `oidcSvcs(...)` / `sharedSecret(...)` peer is a
     *   service in our own trust domain, while a `@WpAuthPublic` / `jwt()` / partner endpoint is
     *   somebody else's process whose response headers are an assertion, not a proof.
     *
     * For every destination in this repo the two directions are one question, so the response side
     * ({@link believesResponse}) delegates here; only an `EXTERNAL_OUTBOUND` destination answers them
     * differently (it sends listed keys and believes none).
     */
    allows(key: AnyContextKey): boolean {
        if (this.externalKeys !== undefined) return this.externalKeys.includes(key);
        return this.verifiesCaller || !key.isTrusted();
    }

    /**
     * May a key that came BACK on this destination's response be merged into our context? Exactly
     * {@link allows} for a destination in this repo — and NOTHING from an `EXTERNAL_OUTBOUND` one,
     * whose response headers are an outside system's, not a peer's. A separate method because for
     * that destination the two directions genuinely differ: a key we LIST to send (`x-request-id`)
     * is not thereby a key we let the vendor write back.
     */
    believesResponse(key: AnyContextKey): boolean {
        if (this.externalKeys !== undefined) return false;
        return this.allows(key);
    }
}
