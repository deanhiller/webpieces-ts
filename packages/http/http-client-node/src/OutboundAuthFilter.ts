import { Filter, Secrets, Service, StreamDirection } from '@webpieces/core-util';
import { SignableRequest, VendorAuthMinter } from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import { ClientRequest } from '@webpieces/http-client-core';

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
 *
 * ## A missing credential never reaches this filter
 *
 * The route's mode was selected by `NodeProxyClient.selectAuthMethod`, the same code that made
 * `createRpcClient` refuse the contract when no declared method was sendable (#1362). So a
 * `sharedSecret(key)` arriving here has a held value and a `vendorAuth(name)` a minter listing `name`;
 * the two checks below only narrow the types, and name the broken invariant if they ever fire.
 */
export class OutboundAuthFilter extends Filter<ClientRequest, Response> {
    constructor(
        private readonly gcpOidc: GcpOidc,
        /** Only sharedSecret(...) endpoints need it; a process that calls none binds nothing. */
        private readonly secrets: Secrets | undefined,
        /**
         * The OUTBOUND role only. Only vendorAuth(...) calls need it, and createRpcClient refuses a
         * contract it cannot call without one. Never the inbound VendorAuthVerifier: sending a request
         * verifies nothing (#1358).
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
                throw new Error(
                    `Invariant broken: ${request.contractName}.${request.route.methodName} selected ` +
                        `sharedSecret('${mode.secretKey}') with no held value; NodeProxyClient.selectAuthMethod never selects it.`,
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

    private async mintVendorAuth(request: ClientRequest, name: string): Promise<void> {
        if (this.vendorAuthMinter === undefined) {
            throw new Error(
                `Invariant broken: ${request.contractName}.${request.route.methodName} selected ` +
                    `vendorAuth('${name}') with no VendorAuthMinter bound; NodeProxyClient.selectAuthMethod never selects it.`,
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
