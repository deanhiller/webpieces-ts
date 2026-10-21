import { AuthenticatedCaller } from './AuthenticatedCaller';
import { RawHttpRequest } from './HttpRequest';

/**
 * VendorAuthVerifier - the INBOUND half of `vendorAuth(name)`: the app-bound mechanism that checks a
 * credential in a scheme the FRAMEWORK does not know when a vendor / partner calls THIS process.
 * `name` selects the vendor, so one verifier serves every vendor this server receives.
 *
 * It is one of TWO independent, optional DI roles behind the one contract declaration
 * `vendorAuth(name)`; its outbound twin is `VendorAuthMinter`. Only the server's `AuthFilter`
 * depends on this role. No outbound RPC client does — so a verifier may itself depend on an ordinary
 * `oidcSameProject()` RPC client (to look a credential or a signing secret up) without closing a
 * construction cycle (#1358).
 *
 * ## It FAILS AT STARTUP
 *
 * A server that SERVES a `vendorAuth(name)` endpoint with no verifier bound, or with a verifier whose
 * {@link supportedVendorNames} does not list `name`, refuses to boot: route registration names the endpoint,
 * the vendor and the binding line (#1362). There is no framework default and there never will be
 * one — never an allow-all.
 *
 * ```typescript
 * // the API server's BindModule
 * binder.bind(VENDOR_AUTH_VERIFIER).to(MyVendorAuthVerifier).inSingletonScope();
 *
 * class MyVendorAuthVerifier extends VendorAuthVerifier {
 *     override supportedVendorNames(): readonly string[] {
 *         return ['bugfixer-sentry'];   // every name verify() below handles
 *     }
 *     override async verify(name: string, request: RawHttpRequest): Promise<AuthenticatedCaller> { ... }
 * }
 * ```
 */
export abstract class VendorAuthVerifier {
    /**
     * Every vendor name {@link verify} handles — each `vendorAuth(name)` this server can verify. A
     * METHOD beside `verify` so the list sits next to the code that dispatches on those names: add a
     * vendor to both in one edit. REQUIRED, no default.
     *
     * Called at STARTUP by route registration (#1362): a served `vendorAuth(name)` route whose name
     * is not listed fails boot. It MUST therefore be PURE — return a fixed list, with no I/O, no
     * network, no credential work and no side effect. {@link verify} is never called at boot.
     */
    abstract supportedVendorNames(): readonly string[];

    /**
     * Verify ONE inbound request. Return the {@link AuthenticatedCaller} the vendor's credential
     * proved; throw `ApiUnauthorizedError` to deny. The framework seeds `entries` with
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
 * DI identifier for the optional {@link VendorAuthVerifier} binding — the INBOUND role only. A Symbol
 * for the same reason as `VENDOR_AUTH_MINTER`: autobind never constructs it, so an unbound verifier
 * is `undefined` and route registration can refuse a served `vendorAuth(...)` endpoint at startup.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const VENDOR_AUTH_VERIFIER = Symbol.for('VendorAuthVerifier');
