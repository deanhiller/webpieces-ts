import { PendingWireTrust, PendingTrustedValue, RequestContext } from '@webpieces/core-context';
import { ApiUnauthorizedError, ApiImplementationError, LogManager, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { VERIFIED_MACHINE_CALLER, VerifiedMachineCaller } from './AuthorizationHook';
import { AuthenticatedCaller, AUTHENTICATED_CALLER_KEY } from './AuthConfig';

const log = LogManager.getLogger('AuthenticatedCallerContext');

/** Shared trusted principal publication and inbound header reconciliation for HTTP and MCP. */
export class AuthenticatedCallerContext {
    private static readonly establishedScopes = new WeakSet<object>();

    // webpieces-disable no-function-outside-class -- stateless contract validation or scope metadata reader used before DI registration
    static hasEstablishedIngress(): boolean {
        return this.establishedScopes.has(RequestContext.activeScopeIdentity());
    }

    publish(caller: AuthenticatedCaller): void {
        this.validateCanonicalIdentity(caller);
        for (const entry of caller.entries) {
            // ContextTuple.key is a TRUSTED key by type, so this is the one sanctioned write of a
            // proven identity: the app's hook derived it from a credential we just verified.
            RequestContext.putTrusted(entry.key, entry.value);
        }
        // A real TRUSTED ContextKey, not a raw string slot: the caller IS the framework's own proof,
        // so it is written with the same typed verb every other proven value goes through.
        RequestContext.putTrusted(AUTHENTICATED_CALLER_KEY, caller);
        if (caller.userId !== undefined) {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, caller.userId);
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ROLES, JSON.stringify(caller.roles));
        }
        if (caller.machine) {
            RequestContext.putTrusted(VERIFIED_MACHINE_CALLER, new VerifiedMachineCaller(caller.machine.mechanism, caller.machine.identity));
        }
    }

    private validateCanonicalIdentity(caller: AuthenticatedCaller): void {
        if ((caller.userId !== undefined && (typeof caller.userId !== 'string' || !caller.userId.trim())) ||
            (caller.userId === undefined && !caller.machine)) {
            throw new ApiImplementationError('Verified caller must contain a nonempty user ID or verified machine identity.');
        }
        if (!Array.isArray(caller.roles) || !caller.roles.every((role: string) => typeof role === 'string' && role.trim().length > 0) ||
            (caller.userId === undefined && caller.roles.length > 0)) {
            throw new ApiImplementationError('Verified caller roles must be nonempty strings belonging to a verified user.');
        }
        for (const entry of caller.entries) {
            if ((entry.key.name === WebpiecesCoreHeaders.USER_ID.name && entry.value !== caller.userId) ||
                (entry.key.name === WebpiecesCoreHeaders.USER_ROLES.name && entry.value !== JSON.stringify(caller.roles))) {
                throw new ApiImplementationError('Canonical user ID/roles entries disagree with the verified caller.');
            }
        }
    }

    reconcileWireTrust(callerVerified: boolean): void {
        const pending = PendingWireTrust.takeAll();
        for (const item of pending) {
            if (callerVerified) {
                RequestContext.putTrusted(item.key, item.value);
            } else {
                this.requireVouched(item);
            }
        }
        const machine = RequestContext.getTrusted(VERIFIED_MACHINE_CALLER);
        if (RequestContext.getTrusted(AUTHENTICATED_CALLER_KEY) ||
            (machine instanceof VerifiedMachineCaller && machine.isCurrentHop())) {
            AuthenticatedCallerContext.establishedScopes.add(RequestContext.activeScopeIdentity());
        }
    }

    /**
     * On a browser-reachable route, an inbound trusted header must match what the authenticator
     * itself derived, or the request dies. Both failure shapes are rejections, not repairs:
     *
     * - DIFFERENT value — the caller said `alice`, the credential says `bob`. Silently letting the
     *   credential win is not safe, because upstream rate limiters commonly bucket on the header
     *   rather than the token: the request was already counted against the wrong principal, so
     *   every forged header would be a free rate-limit bypass. No honest caller contradicts its own
     *   credential.
     * - NOTHING vouched for it — nobody derived this key at all, so there is no evidence behind a
     *   value a stranger typed. This is the common case, not the exotic one: the framework's
     *   {@link DefaultJwtHook} stamps NO entries, and an app hook (jwt or api-key) only stamps the keys it can prove,
     *   so any other trusted key a caller sends lands here.
     *
     * The pending value is discarded either way — the throw is what leaves the request.
     */
    private requireVouched(item: PendingTrustedValue): void {
        const vouched = RequestContext.getTrusted(item.key);
        if (vouched === item.value) {
            return;
        }
        log.error(
            `Rejecting inbound '${item.key.httpHeader}': it is a TRUSTED context key, this route does ` +
                `not authenticate its caller, and the credential ` +
                (vouched === undefined
                    ? 'vouched for no such value'
                    : 'derived a different value') +
                '.',
        );
        throw new ApiUnauthorizedError(
            `Header '${item.key.httpHeader}' cannot be supplied by the caller on this endpoint`,
        );
    }
}
