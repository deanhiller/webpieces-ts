
/**
 * ONE outbound request, as the thing being authenticated — what {@link VendorAuthMinter.mint}
 * receives. Data only.
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
         * timestamp another filter set, a content-type) reads them, and the headers the minter
         * returns are merged by the caller — so there is exactly one place headers are added and it
         * is the return value.
         */
        public readonly headers: ReadonlyMap<string, string>,
        /** The API contract's class name, e.g. 'PartnerWebhookApi'. */
        public readonly contractName: string,
        /** The contract method being called, e.g. 'deliver'. */
        public readonly methodName: string,
    ) {}
}

/**
 * VendorAuthMinter - the OUTBOUND half of `vendorAuth(name)`: the app-bound mechanism that presents a
 * credential in a scheme the FRAMEWORK does not know when THIS process calls a vendor / partner.
 * `name` selects the vendor, so one minter serves every vendor this process calls.
 *
 * It is one of TWO independent, optional DI roles behind the one contract declaration
 * `vendorAuth(name)` — the direction is decided by whether this runtime is SENDING or RECEIVING:
 *
 * | | who presents the credential | who checks it | the role this process binds |
 * |---|---|---|---|
 * | WE call a vendor / partner | us | them | `VendorAuthMinter` ({@link mint}, {@link refresh}) |
 * | a vendor calls US | them | us | `VendorAuthVerifier` (`verify`) |
 *
 * ## Why two roles and not one hook (#1358)
 *
 * The outbound RPC client (`NodeProxyClient`) is constructed for EVERY typed client, including the
 * ordinary `oidcSameProject()` client an inbound verifier uses to look a credential up. When one
 * binding served both directions, every outbound proxy constructed the app's inbound verifier — and
 * a verifier that depends on an RPC proxy closed a construction cycle (`Circular dependency found`)
 * before the process could listen. The outbound client therefore depends on THIS role only, and the
 * server's `AuthFilter` on the verifier only, so the graph is acyclic whatever order the bindings
 * were registered in. A client-only process implements no meaningless `verify`, and a server-only
 * one no meaningless `mint` / `refresh`.
 *
 * The converse holds for THIS role: every RPC client depends on the minter, so a minter reads a
 * credential this process already holds (a paired worker token, an OAuth token store) and must not
 * itself inject a typed RPC client. Validating a credential server-side is the verifier's job, on
 * the server.
 *
 * ## It FAILS AT CLIENT CREATION
 *
 * `createRpcClient` refuses a contract with an endpoint whose only declared credential this client
 * could send is `vendorAuth(name)` when no minter is bound, or the bound minter's {@link supportedVendorNames}
 * does not list `name` — it throws `MissingClientCredentialError` naming the contract, the method and
 * the binding, before any call is made (#1362). An endpoint that also declares a credential this
 * client CAN send (OIDC, a held shared secret) needs no minter. There is no framework default and
 * there never will be one.
 *
 * ```typescript
 * // the CLI / client process's BindModule
 * binder.bind(VENDOR_AUTH_MINTER).to(MyVendorAuthMinter).inSingletonScope();
 *
 * class MyVendorAuthMinter extends VendorAuthMinter {
 *     override supportedVendorNames(): readonly string[] {
 *         return ['clover'];   // every name mint()/refresh() below handle
 *     }
 *     // mint(...) and refresh(...)
 * }
 * ```
 *
 * ## Refresh-once, and who owns serializing it
 *
 * The node client's `OutboundAuthFilter` calls {@link refresh} ONCE when the vendor answers a raw
 * `401`, mints again and re-sends ONCE (never for a streaming upload, whose body cannot be replayed).
 * A second 401 is a failure of THIS service. Serializing a refresh across instances — Clover's
 * refresh tokens are single-use across Cloud Run instances — is the minter's job: webpieces calls it
 * once per logical call and cannot see the other instances. A refresh renews from its OWN valid
 * credential source; it never authenticates through the call it is refreshing for.
 */
export abstract class VendorAuthMinter {
    /**
     * Every vendor name {@link mint} and {@link refresh} handle — each `vendorAuth(name)` this process
     * can call. A METHOD beside `mint` so the list sits next to the code that dispatches on those
     * names: add a vendor to both in one edit. REQUIRED, no default.
     *
     * Called at CLIENT CREATION by `createRpcClient` (#1362), to refuse a contract it cannot call. It
     * MUST therefore be PURE — return a fixed list, with no I/O, no network, no credential work and no
     * side effect. {@link mint} and {@link refresh} are never called then.
     */
    abstract supportedVendorNames(): readonly string[];

    /**
     * Produce the headers that authenticate ONE outbound request, or throw to refuse to send it. An
     * empty map is legal and means "this vendor needs no header".
     *
     * @param name    the string on the contract's `vendorAuth(name)` — which vendor this is.
     * @param request the FINAL request: the absolute url and the exact bytes about to go on the wire.
     */
    abstract mint(name: string, request: SignableRequest): Promise<Map<string, string>>;

    /**
     * The vendor answered `401` to a credential {@link mint} produced. Renew whatever the credential
     * is minted from (refresh an OAuth token, log in again). Called at most ONCE per logical call;
     * {@link mint} runs again afterwards and the request is re-sent once.
     */
    abstract refresh(name: string): Promise<void>;
}

/**
 * DI identifier for the optional {@link VendorAuthMinter} binding — the OUTBOUND role only. It is a
 * Symbol (not the class) so the app container's inversify autobind never auto-constructs this token,
 * keeping `@optional() @inject(VENDOR_AUTH_MINTER)` correct — undefined when unbound, which is what
 * lets `createRpcClient` refuse a contract this process cannot call.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const VENDOR_AUTH_MINTER = Symbol.for('VendorAuthMinter');
