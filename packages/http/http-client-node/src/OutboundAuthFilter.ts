import { Filter, Secrets, Service } from '@webpieces/core-util';
import { GcpOidc } from '@webpieces/gcp-identity';
import { ClientRequest } from '@webpieces/http-client-core';
import { SignableRequest, WebhookSignerCallback } from './WebhookSignerCallback';

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
 * - `@AuthOidc` → a bearer token minted as this caller's runtime SA, audience = the final base URL.
 * - `@AuthSharedSecret` → the value this client holds for that key, as `Authorization: Webpieces …`.
 *   Legitimate against a re-pointed URL: N services implementing ONE contract behind ONE agreed
 *   secret is a real and common topology, and often stands in for OIDC where OIDC is not available.
 * - `@AuthWebhook(name)` → the app's bound {@link WebhookSignerCallback} produces the headers. WE
 *   are the vendor on this side; see that class.
 *
 * Both credential-minting modes ride in the ONE `Authorization` header under their own scheme —
 * `Bearer <oidc>` / `Webpieces <secret>` — which is never a context key, so neither can leak onto
 * the next hop.
 */
export class OutboundAuthFilter extends Filter<ClientRequest, Response> {
    constructor(
        private readonly gcpOidc: GcpOidc,
        /** Only @AuthSharedSecret endpoints need it; a server that has none binds nothing. */
        private readonly secrets: Secrets | undefined,
        /** Only @AuthWebhook endpoints need it, and an unbound one makes them THROW. */
        private readonly webhookSigner: WebhookSignerCallback | undefined,
    ) {
        super();
    }

    override async filter(request: ClientRequest, nextFilter: Service<ClientRequest, Response>): Promise<Response> {
        await this.attach(request);
        return nextFilter.invoke(request);
    }

    private async attach(request: ClientRequest): Promise<void> {
        const mode = request.route.authMeta?.mode;
        if (mode?.kind === 'oidc') {
            request.headers.set('Authorization', `Bearer ${await this.gcpOidc.mintIdToken(request.baseUrl)}`);
            return;
        }
        if (mode?.kind === 'shared-secret') {
            const secret = this.secrets?.get(mode.secretKey);
            if (!secret) {
                throw new Error(
                    `No shared secret configured for @AuthSharedSecret('${mode.secretKey}') endpoint ` +
                        `${request.contractName}.${request.route.methodName}. Bind a Secrets holding that key.`,
                );
            }
            // Same header as a JWT/OIDC token, but its OWN scheme, so a secret can never be
            // mistaken for a token nor accepted where one was expected.
            request.headers.set('Authorization', `Webpieces ${secret}`);
            return;
        }
        if (mode?.kind === 'webhook') {
            await this.signWebhook(request, mode.name);
        }
    }

    /**
     * @throws Error when no {@link WebhookSignerCallback} is bound. FAIL CLOSED, matching the
     *         inbound side exactly: an unbound `WebhookAuthCallback` 401s every `@AuthWebhook`
     *         endpoint rather than admitting it unverified, so an unbound signer must refuse to
     *         send rather than deliver something the partner is obliged to reject.
     */
    private async signWebhook(request: ClientRequest, name: string): Promise<void> {
        if (this.webhookSigner === undefined) {
            throw new Error(
                `${request.contractName}.${request.route.methodName} is @AuthWebhook('${name}'), so this ` +
                    `client must SIGN the request the way ${name} verifies it — but no WebhookSignerCallback ` +
                    `is bound, so there is nothing to produce the signature. Bind one:\n` +
                    `    options.bind(WEBHOOK_SIGNER_CALLBACK).to(MyWebhookSigner);\n` +
                    `Refusing to send is deliberate: an unsigned delivery is one the partner will reject, ` +
                    `and sending it anyway would hide the missing binding until they complained.`,
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
        const signed = await this.webhookSigner.sign(name, signable);
        for (const entry of signed.entries()) {
            request.headers.set(entry[0], entry[1]);
        }
    }
}
