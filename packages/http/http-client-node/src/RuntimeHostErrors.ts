/**
 * The two ways a RUNTIME-HOST client refuses before any bytes leave, each its own type for the same
 * reason {@link SsrfRefusedError} is: a delivery worker has to tell these apart, and they have
 * different owners and different cures.
 *
 * - {@link RuntimeHostEndpointUnsupportedError} — BIND time, OUR bug. The contract declares an auth
 *   mode no runtime-host client can honestly satisfy. It fires when the client is built, so it takes
 *   the process down at startup rather than at the first delivery, which is the point.
 * - {@link MissingRuntimeBaseUrlError} — CALL time, the CALLER's bug. This call was made with no
 *   destination in scope. Retrying is pointless; the fix is at the call site.
 *
 * Neither is an {@link SsrfRefusedError}: nothing about the destination was judged and found hostile.
 * A worker that dead-letters on SSRF should usually PAGE on these instead — they mean the sender is
 * misconfigured, not that a partner registered something dangerous.
 */

/**
 * A runtime-host client was pointed at an endpoint whose auth mode mints a credential for an
 * audience WE choose (`@AuthOidc`, `@AuthSharedSecret`). Thrown at BIND time, from
 * `HostPolicy.assertEndpointSupported`.
 */
export class RuntimeHostEndpointUnsupportedError extends Error {
    constructor(
        message: string,
        /** `Contract.method`, so a startup failure names the endpoint without reading a stack. */
        public readonly endpoint: string,
    ) {
        super(message);
        this.name = 'RuntimeHostEndpointUnsupportedError';
    }
}

/**
 * A runtime-host client was called with no `WebpiecesCoreHeaders.OVERRIDE_BASE_URL` in the ambient
 * RequestContext, so there is no destination for this call.
 *
 * It is a THROW rather than a fallback to a derived service URL, deliberately: a silent fallback
 * would send a partner's payload to one of our own services, which is a worse outcome than a loud
 * failure by every measure.
 */
export class MissingRuntimeBaseUrlError extends Error {
    constructor(
        message: string,
        /** `Contract.method`, so the log line names the call that had nowhere to go. */
        public readonly endpoint: string,
    ) {
        super(message);
        this.name = 'MissingRuntimeBaseUrlError';
    }
}
