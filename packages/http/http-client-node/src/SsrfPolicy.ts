/**
 * What a destination supplied at RUNTIME has to satisfy before this client will send to it: HTTPS
 * only, no internal addresses, at most one redirect — each hop re-judged.
 *
 * DATA ONLY — the enforcement is {@link SsrfGuardFilter}, and the trigger is
 * `ClientRequest.destinationCameFromData`: a URL that came out of `ClientRegistry` is an address WE
 * chose and is never judged, so an ordinary service-to-service client pays nothing for this class
 * existing.
 *
 * THIS class is what a client gets by saying nothing, and it is the whole policy — there is no
 * argument to soften, no scheme list to widen, no flag to flip. Relaxing it means naming a
 * DIFFERENT class, {@link SsrfTestingPolicy}, which is why that one carries a required reason.
 */
export class SsrfPolicy {
    /**
     * URL schemes that may be sent to, with their colons. HTTPS-only: a partner-registered
     * destination reached over plaintext http leaks the payload and its signature to anything on the
     * path, and "the partner has not got TLS yet" is their bug to fix, not ours to accommodate
     * silently.
     */
    readonly allowedSchemes: ReadonlySet<string> = new Set(['https:']);

    /** When true, the loopback / RFC1918 / link-local / metadata refusals are skipped. */
    readonly allowInternalAddresses: boolean = false;

    /**
     * How many redirects may be followed, each one re-judged under this same policy. Small on
     * purpose: a legitimate webhook endpoint does not need a redirect chain, and every hop is
     * another chance for the destination to move somewhere we did not agree to.
     */
    readonly maxRedirects: number = 1;

    /** WHY internal addresses are allowed, in prose, when they are. See {@link SsrfTestingPolicy}. */
    readonly allowInternalReason: string | undefined = undefined;
}

/**
 * {@link SsrfPolicy} with plaintext http and internal addresses ALLOWED, for the one case that
 * genuinely needs them: exercising the partner delivery path against a local fake, where the
 * per-call URL is `http://127.0.0.1:9123`.
 *
 * This is NOT the way to reach a local emulator by service name. `ClientRegistry.addMapping` already
 * covers that, and a registry-resolved URL is never SSRF-checked in the first place — so a localhost
 * peer needs no opt-out at all, and anyone reaching for this class to get one is in the wrong place.
 *
 * THE LONG NAME IS THE FEATURE. This is the permissive branch, so it is a NOUN a reviewer can grep —
 * `grep -rn SsrfTestingPolicy` lists every client in a codebase that can reach inside the network
 * with a runtime-supplied URL — rather than a boolean, an omitted argument, or an empty allow-list. A
 * widening that reads as an ABSENCE is invisible exactly where it matters most.
 */
export class SsrfTestingPolicy extends SsrfPolicy {
    override readonly allowedSchemes: ReadonlySet<string> = new Set(['https:', 'http:']);
    override readonly allowInternalAddresses: boolean = true;
    override readonly allowInternalReason: string;

    constructor(
        /**
         * WHY this client may reach internal addresses, in prose. REQUIRED, and quoted back in this
         * client's refusals, so the justification travels with the decision instead of living in a
         * commit message nobody will find.
         */
        reason: string,
    ) {
        super();
        this.allowInternalReason = reason;
    }
}
