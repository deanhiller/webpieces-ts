/**
 * Secrets - the CLIENT-side shared-secret store: the ONE value THIS service currently SENDS per
 * `@AuthSharedSecret(key)` name. Bound once (from config; tests pass literals) and used by every
 * outbound client (the RPC http-client + the Cloud Tasks invokers) — NEVER read from process.env in
 * the send path, so tests stay parallel-safe.
 *
 * The SERVER counterpart accepts TWO values per key ({@link SharedSecrets}) for zero-downtime
 * rotation; a client sends ONE and is migrated by changing its value here. Data-only structure (a
 * class, per the webpieces guidelines).
 */
export class Secrets {
    // Values are `string | undefined` so a process.env slot drops straight in with no `?? ''` noise:
    //   new Secrets({ INTERNAL_API_SECRET: process.env['INTERNAL_API_SECRET'], KEY2: process.env['KEY2'] })
    constructor(private readonly values: Record<string, string | undefined> = {}) {}

    /** The secret this client sends for the given `@AuthSharedSecret(key)`, or undefined if unset. */
    get(key: string): string | undefined {
        return this.values[key];
    }
}
