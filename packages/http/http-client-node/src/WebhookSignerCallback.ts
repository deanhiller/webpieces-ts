/**
 * The OUTBOUND half of `@AuthWebhook(name)` — the exact mirror of `WebhookAuthCallback`, which is
 * the INBOUND half.
 *
 * `@AuthWebhook('partner-hmac')` on a contract says: this hop is authenticated by a signature over
 * the request, in a scheme the FRAMEWORK does not know. Which side of it you are on decides which
 * hook runs, and nothing else changes:
 *
 * | | who signs | who verifies | the hook |
 * |---|---|---|---|
 * | a vendor posts to US | the vendor | us | `WebhookAuthCallback.verifyWebhook` (http-routing) |
 * | WE post to a partner | us | the partner | `WebhookSignerCallback.sign` (here) |
 *
 * The symmetry is the point: ONE decorator on ONE contract describes the credential, and the same
 * `name` selects the same vendor's scheme on both sides. A server that receives Twilio's callbacks
 * and a client that delivers to a partner read identically.
 *
 * ## Why a hook and not an `@AuthHmac` decorator
 *
 * Because there is no such thing as "the" HMAC scheme. Twilio signs the full absolute URL with its
 * sorted parameters; Slack signs `v0:{timestamp}:{body}`; Meta signs the raw body alone; GitHub and
 * Stripe each differ again in prefix, header name and encoding. A decorator that took a secret
 * would have to pick one of those and be wrong for everyone else, and a framework that shipped five
 * vendors' crypto would be shipping five things to keep in step with five vendors. So the scheme
 * lives in the app's hook, the VENDOR lives on the contract, and the framework carries neither.
 *
 * ## It FAILS CLOSED
 *
 * With no `WebhookSignerCallback` bound, every outbound `@AuthWebhook` call THROWS rather than
 * going out unsigned — exactly as an unbound `WebhookAuthCallback` 401s every inbound
 * `@AuthWebhook` endpoint. An unsigned delivery is not a degraded delivery; it is a request the
 * partner is obliged to reject, and quietly sending one hides the missing binding until a partner
 * complains.
 *
 * ```typescript
 * // AppModule.ts
 * options.bind(WEBHOOK_SIGNER_CALLBACK).to(PartnerHmacSigner);
 * ```
 *
 * ONE hook serves EVERY partner, the way the inbound one serves every vendor: `name` selects which.
 */
export abstract class WebhookSignerCallback {
    /**
     * Produce the headers that authenticate ONE outbound request, or throw to refuse to send it.
     *
     * @param name    the string on the contract's `@AuthWebhook(name)` — which partner this is.
     * @param request the FINAL request: the absolute url and the exact bytes that are about to go on
     *                the wire. See {@link SignableRequest} for why both of those words matter.
     * @returns header name -> value, merged onto the request. An empty map is legal and means "this
     *          partner needs no header" — it is not a way to opt out of signing, because returning
     *          it is a statement the hook made rather than a binding somebody forgot.
     */
    abstract sign(name: string, request: SignableRequest): Promise<Map<string, string>>;
}

/**
 * ONE outbound request, as the thing being signed. Data only.
 *
 * Every field a real vendor scheme needs is here, and the two that make it correct are {@link url}
 * and {@link body}:
 *
 * - {@link url} is the FINAL absolute URL, after every app filter has had its say. A signature
 *   computed over the pre-filter URL authenticates a request nobody sent — and for a partner-webhook
 *   client the pre-filter URL is the client's own service name, which is not a destination at all.
 * - {@link body} is the EXACT serialized bytes the transport will send, not the DTO. Serialization
 *   happens before the filter chain runs and the transport sends this same string verbatim, so the
 *   bytes signed and the bytes sent cannot differ. That was impossible while the client owned
 *   serialization internally with no seam, which is why outbound webhook senders were forced back
 *   to hand-rolling `JSON.stringify` plus a raw HTTP library — a library that re-serializes
 *   internally signs one byte sequence and sends another, and the failure is silent.
 */
export class SignableRequest {
    constructor(
        /** The FINAL absolute URL this request is about to be sent to. */
        public readonly url: string,
        /** The HTTP method, e.g. 'POST'. */
        public readonly httpMethod: string,
        /** The EXACT serialized body, or undefined for a call with no argument. */
        public readonly body: string | undefined,
        /**
         * The headers as they stand. READ-ONLY here: a scheme that signs existing headers (a
         * timestamp another filter set, a content-type) reads them, and the signature it returns is
         * merged by the caller — so there is exactly one place headers are added and it is the
         * return value.
         */
        public readonly headers: ReadonlyMap<string, string>,
        /** The API contract's class name, e.g. 'PartnerWebhookApi'. */
        public readonly contractName: string,
        /** The contract method being called, e.g. 'deliver'. */
        public readonly methodName: string,
    ) {}
}

/**
 * DI identifier for the optional {@link WebhookSignerCallback} binding. It is a Symbol (not the
 * class) so the app container's inversify autobind never auto-constructs this token, keeping
 * `@optional() @inject(WEBHOOK_SIGNER_CALLBACK)` correct — undefined when unbound, which is what
 * makes the fail-closed refusal reachable. Mirrors WEBHOOK_AUTH_CALLBACK exactly.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const WEBHOOK_SIGNER_CALLBACK = Symbol.for('WebhookSignerCallback');
