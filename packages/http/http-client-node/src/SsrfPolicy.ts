/**
 * What a runtime-supplied destination has to satisfy before this client will send to it.
 *
 * DATA ONLY — the enforcement is {@link SsrfGuardFilter}. It is constructed by a
 * {@link HostPolicy}, never by app code directly, because the CHOICE between the strict policy and
 * the internal-addresses one is made by naming a host-policy class at the `new ClientConfig(...)`
 * call site. That keeps the permissive answer a greppable noun rather than a boolean somebody
 * flipped.
 */
export class SsrfPolicy {
    constructor(
        /**
         * URL schemes that may be sent to, with their colons ('https:'). HTTPS-only by default: a
         * partner-registered destination reached over plaintext http leaks the payload and its
         * signature to anything on the path, and "the partner has not got TLS yet" is their bug to
         * fix, not ours to accommodate silently.
         */
        public readonly allowedSchemes: ReadonlySet<string>,
        /**
         * TRUE only under {@link RuntimeHostFromContextAllowingInternalAddresses}. When true, the
         * loopback / RFC1918 / link-local / metadata refusals are skipped — scheme checking and the
         * redirect cap still apply.
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
         * {@link RuntimeHostFromContextAllowingInternalAddresses} and quoted in the log line the
         * guard writes, so the reason travels with the decision instead of living in a commit
         * message nobody will find.
         */
        public readonly allowInternalReason: string | undefined,
    ) {}
}
