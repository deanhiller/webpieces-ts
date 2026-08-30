/**
 * A client carrying a {@link ContextBaseUrlFilter} was called with no
 * `WebpiecesCoreHeaders.OVERRIDE_BASE_URL` in the ambient RequestContext, so this call has nowhere
 * to go.
 *
 * It is a THROW rather than a fallback to the client's configured service URL, deliberately: a
 * silent fallback would send a partner's payload to one of our own services, which is a worse
 * outcome than a loud failure by every measure.
 *
 * Its OWN type, not a bare Error and NOT an {@link SsrfRefusedError}: a delivery worker has to tell
 * "we were misconfigured" (page somebody; retrying is pointless) from "the partner registered
 * something hostile" (dead-letter it). Different owners, different cures.
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
