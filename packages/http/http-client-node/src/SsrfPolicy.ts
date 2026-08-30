/**
 * What a destination supplied at RUNTIME has to satisfy before this client will send to it.
 *
 * DATA ONLY — the enforcement is {@link SsrfGuardFilter}, and the trigger is
 * `ClientRequest.destinationCameFromData`: a URL that came out of `ClientRegistry` is an address WE
 * chose and is never judged, so a normal service-to-service client pays nothing for this class
 * existing.
 *
 * The two factories below are the only two ways to obtain one, and they are NOT two spellings of
 * one thing: {@link strict} is what every client gets, automatically, with no way to ask for it and
 * no way to decline it; {@link forTesting} is a deliberate, reason-carrying widening that an app
 * must name at a construction site. Naming the permissive one is the feature —
 * `grep -rn 'SsrfPolicy.forTesting'` lists every client in a codebase that can reach inside the
 * network with a runtime-supplied URL, which a boolean, an omitted argument or an empty allow-list
 * could never be made to do.
 */
export class SsrfPolicy {
    private constructor(
        /**
         * URL schemes that may be sent to, with their colons ('https:'). HTTPS-only under
         * {@link strict}: a partner-registered destination reached over plaintext http leaks the
         * payload and its signature to anything on the path, and "the partner has not got TLS yet"
         * is their bug to fix, not ours to accommodate silently.
         */
        public readonly allowedSchemes: ReadonlySet<string>,
        /**
         * TRUE only under {@link forTesting}. When true, the loopback / RFC1918 / link-local /
         * metadata refusals are skipped — scheme checking and the redirect cap still apply.
         */
        public readonly allowInternalAddresses: boolean,
        /**
         * How many redirects may be followed, each one re-judged under this same policy. Small on
         * purpose: a legitimate webhook endpoint does not need a redirect chain, and every hop is
         * another chance for the destination to move somewhere we did not agree to.
         */
        public readonly maxRedirects: number,
        /**
         * WHY internal addresses are allowed, in prose, when they are. Required by
         * {@link forTesting} and quoted in the refusals this client produces, so the justification
         * travels with the decision instead of living in a commit message nobody will find.
         */
        public readonly allowInternalReason: string | undefined,
    ) {}

    /**
     * HTTPS only, no internal addresses, at most one redirect — each hop re-judged. What a
     * re-pointed request is held to unless a `ContextBaseUrlFilter` was handed something else.
     */
    static strict(): SsrfPolicy {
        return new SsrfPolicy(new Set(['https:']), false, 1, undefined);
    }

    /**
     * Plaintext http and internal addresses ALLOWED, for the one case that genuinely needs them:
     * exercising the partner delivery path against a local fake, where the per-call URL is
     * `http://127.0.0.1:9123`.
     *
     * This is NOT the way to reach a local emulator by service name — `ClientRegistry.addMapping`
     * already covers that, and a registry-resolved URL is never SSRF-checked in the first place.
     *
     * @param reason WHY this client may reach internal addresses, in prose. Required, and quoted
     *               back in this client's messages.
     */
    static forTesting(reason: string): SsrfPolicy {
        return new SsrfPolicy(new Set(['https:', 'http:']), true, 1, reason);
    }
}
