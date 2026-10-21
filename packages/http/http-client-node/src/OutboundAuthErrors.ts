/**
 * The two ways outbound auth refuses to send, each its own type for the reason
 * {@link MissingRuntimeBaseUrlError} is one: a delivery worker has to tell these apart from
 * {@link SsrfRefusedError}. Both mean THIS SERVICE is misconfigured — page somebody, retrying is
 * pointless — where an SSRF refusal means a partner registered something hostile and the delivery
 * should be dead-lettered. A bare `Error` forces that decision to be made by matching message text.
 *
 * Neither is thrown for anything a caller can influence: they fire when the binding a contract's
 * auth mode requires is simply absent.
 */

/**
 * An `sharedSecret(key)` endpoint was called by a client whose bound `Secrets` holds no value
 * for that key. Thrown at CALL time, from `OutboundAuthFilter`.
 */
export class MissingSharedSecretError extends Error {
    constructor(
        message: string,
        /** `Contract.method`, so the log line names the call without a stack read. */
        public readonly endpoint: string,
        /** The `sharedSecret(...)` key that had no value, so the fix names itself. */
        public readonly secretKey: string,
    ) {
        super(message);
        this.name = 'MissingSharedSecretError';
    }
}

/**
 * A `vendorAuth(name)` endpoint was called outbound with no `VendorAuthMinter` (VENDOR_AUTH_MINTER)
 * bound, so nothing can mint the credential the vendor checks. Thrown at CALL time, from
 * `OutboundAuthFilter`, BEFORE anything is sent — the mirror of the inbound side, where an unbound
 * `VendorAuthVerifier` 401s every served `vendorAuth(...)` endpoint instead of admitting it.
 */
export class MissingVendorAuthMinterError extends Error {
    constructor(
        message: string,
        /** `Contract.method`, so the log line names the call without a stack read. */
        public readonly endpoint: string,
        /** The vendor on the contract's `vendorAuth(name)`, which selects the scheme. */
        public readonly vendorName: string,
    ) {
        super(message);
        this.name = 'MissingVendorAuthMinterError';
    }
}
