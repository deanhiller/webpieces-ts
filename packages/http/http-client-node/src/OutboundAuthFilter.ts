import { Filter, Secrets, Service, StreamDirection } from '@webpieces/core-util';
import { SignableRequest, VendorAuthMinter } from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import { ClientRequest } from '@webpieces/http-client-core';
import { MissingSharedSecretError, MissingVendorAuthMinterError } from './OutboundAuthErrors';

/**
 * Attaches the endpoint's outbound credential, against the destination the call is ACTUALLY going
 * to.
 *
 * ## Why this is a filter, and why it is the LAST one
 *
 * It used to be a method on the client, called before the request object even existed — so it
 * minted against the URL the client resolved at bind time, which is the URL BEFORE any filter had
 * run. That is wrong the moment a filter can re-point the request: an OIDC token's audience is the
 * callee's base URL, and a token minted for our own service name and then sent to a partner's
 * server is a credential handed to the wrong party.
 *
 * As the innermost filter (`ProxyClient.initRoutes` puts the framework's built-ins beneath every app
 * filter, and no app priority can get under them) it reads `request.baseUrl` / `request.url` after
 * everything has settled, which makes the audience correct by construction rather than by
 * convention. The SSRF guard sits immediately ABOVE it, so a destination that is going to be refused
 * is refused BEFORE any credential is minted for it.
 *
 * ## The three modes, and why none of them is restricted to a fixed host
 *
 * - `oidcSameProject()` / `oidcSvcs(...)` → a bearer token minted as this caller's runtime SA, audience = the final base URL.
 * - `sharedSecret(...)` → the value this client holds for that key, as `Authorization: Webpieces …`.
 *   Legitimate against a re-pointed URL: N services implementing ONE contract behind ONE agreed
 *   secret is a real and common topology, and often stands in for OIDC where OIDC is not available.
 * - `vendorAuth(name)` → the app's bound {@link VendorAuthMinter} `mint`s the headers (a vendor's
 *   OAuth bearer, a partner's HMAC signature — the scheme is the app's). On a raw `401` it is the ONE
 *   mode that retries: cancel the 401's body, `refresh(name)` once, `mint` again and re-send ONCE.
 *   Never for a streaming upload (its body cannot be replayed), and once per logical call — the SSRF
 *   guard's redirect loop re-enters this filter for each hop, and a second 401 goes up the chain to
 *   `ClientErrorTranslator` exactly as before, because a service that cannot log in to its vendor
 *   twice running is a bug in THAT service.
 *
 * Both credential-minting modes ride in the ONE `Authorization` header under their own scheme —
 * `Bearer <oidc>` / `Webpieces <secret>` — which is never a context key, so neither can leak onto
 * the next hop.
 */
export class OutboundAuthFilter extends Filter<ClientRequest, Response> {
    constructor(
        private readonly gcpOidc: GcpOidc,
        /** Only sharedSecret(...) endpoints need it; a server that has none binds nothing. */
        private readonly secrets: Secrets | undefined,
        /**
         * The OUTBOUND role only. Only vendorAuth(...) calls need it, and an unbound one makes them
         * THROW. Never the inbound VendorAuthVerifier: sending a request verifies nothing (#1358).
         */
        private readonly vendorAuthMinter: VendorAuthMinter | undefined,
    ) {
        super();
    }

    /** Requests that already spent their one refresh — keyed by the request, so redirect hops share it. */
    private readonly refreshed = new WeakSet<ClientRequest>();

    override async filter(
        request: ClientRequest,
        nextFilter: Service<ClientRequest, Response>,
    ): Promise<Response> {
        await this.attach(request);
        const response = await nextFilter.invoke(request);
        const mode = request.route.authMeta?.methods[0];
        if (
            response.status !== 401 ||
            mode?.kind !== 'vendorAuth' ||
            this.refreshed.has(request) ||
            this.uploadsAStream(request)
        ) {
            return response;
        }
        this.refreshed.add(request);
        // The 401's body is never read: release the connection before the second attempt.
        await response.body?.cancel();
        await this.vendorAuthMinter!.refresh(mode.name);
        await this.mintVendorAuth(request, mode.name);
        return nextFilter.invoke(request);
    }

    /** A request-streaming call's body is a one-shot stream, so it can never be re-sent. */
    private uploadsAStream(request: ClientRequest): boolean {
        const streaming = request.route.streaming;
        return streaming !== undefined && streaming.direction !== StreamDirection.RESPONSE;
    }

    private async attach(request: ClientRequest): Promise<void> {
        const mode = request.route.authMeta?.methods[0];
        if (mode?.kind === 'oidc') {
            request.headers.set(
                'Authorization',
                `Bearer ${await this.gcpOidc.mintIdToken(request.baseUrl)}`,
            );
            return;
        }
        if (mode?.kind === 'shared-secret') {
            const secret = this.secrets?.get(mode.secretKey);
            if (!secret) {
                throw new MissingSharedSecretError(
                    `${request.contractName}.${request.route.methodName} is ` +
                        `sharedSecret('${mode.secretKey}'), but this client's bound Secrets holds no ` +
                        `value for that key, so there is no credential to send. Bind a Secrets carrying ` +
                        `'${mode.secretKey}'. Refusing to send is deliberate: the callee is obliged to 401 an ` +
                        `unauthenticated request, so sending it would report as the peer's failure.`,
                    `${request.contractName}.${request.route.methodName}`,
                    mode.secretKey,
                );
            }
            // Same header as a JWT/OIDC token, but its OWN scheme, so a secret can never be
            // mistaken for a token nor accepted where one was expected.
            request.headers.set('Authorization', `Webpieces ${secret}`);
            return;
        }
        if (mode?.kind === 'vendorAuth') {
            await this.mintVendorAuth(request, mode.name);
        }
    }

    /**
     * @throws MissingVendorAuthMinterError when no {@link VendorAuthMinter} is bound. FAIL CLOSED,
     *         matching the inbound side exactly: an unbound verifier 401s every served
     *         `vendorAuth(...)` endpoint rather than admitting it unverified, so an unbound minter
     *         must also refuse to SEND rather than deliver something the vendor is obliged to reject.
     */
    private async mintVendorAuth(request: ClientRequest, name: string): Promise<void> {
        if (this.vendorAuthMinter === undefined) {
            throw new MissingVendorAuthMinterError(
                `${request.contractName}.${request.route.methodName} is vendorAuth('${name}'), so this ` +
                    `client must present ${name}'s credential — but no VendorAuthMinter is bound, so there ` +
                    `is nothing to mint it. Bind the OUTBOUND role in this process:\n` +
                    `    binder.bind(VENDOR_AUTH_MINTER).to(MyVendorAuthMinter).inSingletonScope();\n` +
                    `(A VENDOR_AUTH_VERIFIER binding does not count: it verifies inbound calls and never sends.)\n` +
                    `Refusing to send is deliberate: an unauthenticated call is one the vendor will reject, ` +
                    `and sending it anyway would hide the missing binding until they complained.`,
                `${request.contractName}.${request.route.methodName}`,
                name,
            );
        }
        const signable = new SignableRequest(
            request.url,
            request.route.httpMethod,
            request.body,
            request.headers,
            request.contractName,
            request.route.methodName,
        );
        const minted = await this.vendorAuthMinter.mint(name, signable);
        for (const entry of minted.entries()) {
            request.headers.set(entry[0], entry[1]);
        }
    }
}
