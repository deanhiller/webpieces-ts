/**
 * The ONE way outbound auth refuses a contract: an endpoint declares no credential this client can
 * send. Thrown at CLIENT CREATION (`createRpcClient`, from `NodeProxyClient.assertEndpointSupported`),
 * before any call is made (#1362) — it replaces the call-time `MissingSharedSecretError` and
 * `MissingVendorAuthMinterError`, which fired only on the first call and only for one mode.
 *
 * Its own type for the reason {@link MissingRuntimeBaseUrlError} is one: it means THIS SERVICE is
 * misconfigured — page somebody, retrying is pointless — and nothing a caller sends can cause it. A
 * bare `Error` would force a host to tell it apart from {@link SsrfRefusedError} by matching message
 * text.
 *
 * ONE PER ENDPOINT, not every alternative: a client needs only ONE declared method it can send now
 * (OIDC and public always; `sharedSecret(key)` when its bound `Secrets` holds `key`; `vendorAuth(name)`
 * when its bound `VendorAuthMinter`'s `supportedVendorNames()` lists `name`; `jwt()` / `apiKey(...)`,
 * which the app relays per call). A CLI need not hold OIDC credentials just because
 * the contract ALSO allows OIDC.
 */
export class MissingClientCredentialError extends Error {
    constructor(
        message: string,
        /** `Contract.method`, so the log line names the endpoint without a stack read. */
        public readonly endpoint: string,
        /** Every declared method, as written on the contract, e.g. `vendorAuth('clover')`. */
        public readonly declared: readonly string[],
    ) {
        super(message);
        this.name = 'MissingClientCredentialError';
    }
}
