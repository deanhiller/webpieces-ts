import { AnyContextKey } from '../ContextKey';
import { AuthMode } from './auth-mode';

/**
 * DestinationTrust - the OUTBOUND half of the trust model: may a TRUSTED context key
 * ({@link ContextKey.trusted}) ride to the endpoint we are about to call?
 *
 * ## Why the client has to answer this at all
 *
 * The server already decided (see `PendingWireTrust`): an inbound `x-user-id` is admitted only on a
 * route that verified WHO called it — `@AuthOidc` / `@AuthSharedSecret`. On a `@AuthJwt` or `@Public`
 * route the same header must match what the authenticator independently derived, or the request is
 * REJECTED with a 401.
 *
 * That rule is correct, and it means a client that ships `x-user-id` to a `@Public` endpoint is
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
     * The destination authenticates its CALLER (@AuthOidc / @AuthSharedSecret), so it is entitled to
     * believe context WE vouch for — this is the service-to-service identity propagation that trusted
     * keys keep an `httpHeader` for.
     */
    private static readonly VERIFIES_CALLER = new DestinationTrust(true);

    /**
     * The destination cannot tell us from a browser with curl (@AuthJwt / @Public / @AuthWebhook /
     * @AuthApiKey / @AuthLocalOnly / an endpoint with no declared mode), so trusted keys are omitted.
     * Untrusted keys still travel.
     */
    private static readonly CANNOT_VERIFY_CALLER = new DestinationTrust(false);

    private constructor(private readonly verifiesCaller: boolean) {}

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
            // @AuthWebhook authenticates an OUTSIDE VENDOR, which is not the same thing as
            // authenticating a peer in this repo. The vendor knows nothing of webpieces context
            // headers and would never send one, so there is no identity to propagate in either
            // direction — and a webpieces client cannot call such an endpoint anyway (it cannot mint
            // the vendor's signature). Trusted keys stay home.
            case 'webhook':
            // @AuthApiKey authenticates a CUSTOMER, not a peer service. The holder of the key is
            // another company's codebase, so nothing it forwards may be believed, and no webpieces
            // client can call it anyway (the framework extracts no api-key header — the app's hook
            // owns which headers carry the credential; the contract's `credentials` list only DESCRIBES
            // them). Trusted keys stay home.
            case 'apikey':
            // @AuthLocalOnly authenticates NOBODY — it gates on the environment, not on a
            // credential — so a browser with curl on the same laptop is indistinguishable from us.
            // Same bucket as public/jwt. (This switch has NO `default` on purpose: adding a kind to
            // AuthMode is a compile error here rather than a silent permissive fallthrough.)
            case 'local-only':
                return DestinationTrust.CANNOT_VERIFY_CALLER;
        }
    }

    /**
     * May this key go on the wire to this destination? Untrusted keys always may — nobody was ever
     * going to make a security decision on them. A trusted key may only when the destination will
     * authenticate US, because that is the only case its `AuthFilter` will admit it.
     */
    allows(key: AnyContextKey): boolean {
        return this.verifiesCaller || !key.isTrusted();
    }
}
