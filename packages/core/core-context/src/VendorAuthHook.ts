import { AuthenticatedCaller } from './AuthenticatedCaller';
import { RawHttpRequest } from './HttpRequest';

/**
 * ONE outbound request, as the thing being authenticated — what {@link VendorAuthHook.mint} receives.
 * Data only.
 *
 * Every field a real vendor scheme needs is here, and the two that make it correct are {@link url}
 * and {@link body}:
 *
 * - {@link url} is the FINAL absolute URL, after every app filter has had its say. A signature
 *   computed over the pre-filter URL authenticates a request nobody sent — and for a partner-webhook
 *   client the pre-filter URL is the client's own service name, which is not a destination at all.
 * - {@link body} is the EXACT serialized bytes the transport will send, not the DTO. Serialization
 *   happens before the filter chain runs and the transport sends this same string verbatim, so the
 *   bytes signed and the bytes sent cannot differ. A library that re-serializes internally signs one
 *   byte sequence and sends another, and the failure is silent.
 */
export class SignableRequest {
    constructor(
        /** The FINAL absolute URL this request is about to be sent to. */
        public readonly url: string,
        /** The HTTP method, e.g. 'POST'. */
        public readonly httpMethod: string,
        /** The EXACT serialized body, or undefined for a call with no body. */
        public readonly body: string | undefined,
        /**
         * The headers as they stand. READ-ONLY here: a scheme that signs existing headers (a
         * timestamp another filter set, a content-type) reads them, and the headers the hook returns
         * are merged by the caller — so there is exactly one place headers are added and it is the
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
 * VendorAuthHook - the ONE app-bound mechanism behind `vendorAuth(name)`: a credential in a scheme
 * the FRAMEWORK does not know, on BOTH ends of a hop. Modelled on `JwtHook` (which mints on one side
 * and parses on the other); `name` selects the vendor, so one hook serves every vendor.
 *
 * | | who presents the credential | who checks it | the method |
 * |---|---|---|---|
 * | WE call a vendor / partner | us | them | {@link mint}, and {@link refresh} once on a 401 |
 * | a vendor calls US | them | us | {@link verify} |
 *
 * ## Why a hook and not a framework scheme
 *
 * Because there is no such thing as "the" vendor scheme. Clover wants a per-merchant OAuth bearer
 * token; Toast a machine-client login token; Twilio signs the full absolute URL with its sorted
 * parameters; Slack signs `v0:{timestamp}:{body}`; Meta the raw body alone. A decorator that took a
 * secret would pick one and be wrong for everyone else. So the scheme lives in the app's hook, the
 * VENDOR lives on the contract, and the framework carries neither.
 *
 * ## It FAILS CLOSED, on both ends
 *
 * With no hook bound, every outbound `vendorAuth(...)` call THROWS rather than going out
 * unauthenticated, and every inbound `vendorAuth(...)` endpoint answers 401. There is no framework
 * default and there never will be one.
 *
 * ```typescript
 * // AppModule.ts, beside the JwtHook binding
 * options.bind(VENDOR_AUTH_HOOK).to(MyVendorAuthHook);
 * ```
 *
 * ## Refresh-once, and who owns serializing it
 *
 * The node client's `OutboundAuthFilter` calls {@link refresh} ONCE when the vendor answers a raw
 * `401`, mints again and re-sends ONCE (never for a streaming upload, whose body cannot be replayed).
 * A second 401 is a failure of THIS service. Serializing a refresh across instances — Clover's
 * refresh tokens are single-use across Cloud Run instances — is the hook's job: webpieces calls it
 * once per logical call and cannot see the other instances.
 */
export abstract class VendorAuthHook {
    /**
     * CLIENT: produce the headers that authenticate ONE outbound request, or throw to refuse to send
     * it. An empty map is legal and means "this vendor needs no header".
     *
     * @param name    the string on the contract's `vendorAuth(name)` — which vendor this is.
     * @param request the FINAL request: the absolute url and the exact bytes about to go on the wire.
     */
    abstract mint(name: string, request: SignableRequest): Promise<Map<string, string>>;

    /**
     * CLIENT: the vendor answered `401` to a credential {@link mint} produced. Renew whatever the
     * credential is minted from (refresh an OAuth token, log in again). Called at most ONCE per
     * logical call; {@link mint} runs again afterwards and the request is re-sent once.
     */
    abstract refresh(name: string): Promise<void>;

    /**
     * SERVER: verify ONE inbound request. Return the {@link AuthenticatedCaller} the vendor's
     * credential proved; throw `ApiUnauthorizedError` to deny. The framework seeds `entries` with
     * `RequestContext.putTrusted`, as it does for a jwt or api-key caller. `vendorAuth` stays
     * caller-NOT-verified for trusted-header purposes: a vendor is not a peer service, so nothing it
     * merely ASSERTS on the wire is admitted.
     *
     * @param name    the string on the contract's `vendorAuth(name)` — which vendor this route is.
     * @param request narrowed to {@link RawHttpRequest}: `request.raw` (the verbatim bytes + absolute
     *                url) is PRESENT, because a served `vendorAuth(...)` endpoint requires
     *                `@Endpoint(..., { rawBody: true })` at wiring time.
     */
    abstract verify(name: string, request: RawHttpRequest): Promise<AuthenticatedCaller>;
}

/**
 * DI identifier for the optional {@link VendorAuthHook} binding. It is a Symbol (not the class) so the
 * app container's inversify autobind never auto-constructs this token, keeping
 * `@optional() @inject(VENDOR_AUTH_HOOK)` correct — undefined when unbound, which is what makes the
 * fail-closed refusal reachable on both ends.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const VENDOR_AUTH_HOOK = Symbol.for('VendorAuthHook');
