/**
 * LogFieldMask - opt-in field masking for the {@link LogApiCallImpl} logging path ONLY.
 *
 * WHY this exists: LogApiCall stringifies whole request/response DTOs into the logs. Any secret
 * riding on a DTO across a logged hop (an OAuth refresh token, an id-token JWT) is otherwise written
 * to the log in cleartext. A {@link MaskSpec} lets a caller declare, per api/method, which fields are
 * sensitive and how to render them — so the secret is masked in the log while the REAL value still
 * travels on the wire untouched.
 *
 * THE TRAP (documented so it is never reintroduced): masking MUST live in the logging path only, and
 * NEVER as `toJSON()` on the DTO. `JSON.stringify` is also what the RPC transport uses to put the DTO
 * ON THE WIRE, so a masking `toJSON()` would send `"*****"` to the real server and break auth at
 * runtime. {@link MaskSpec.stringify} produces a masked STRING for the log without ever mutating the
 * DTO, so the object handed to the transport is untouched.
 *
 * COST: paid ONLY when a MaskSpec is supplied. With no spec, LogApiCall calls plain `JSON.stringify`
 * exactly as before — no walk, no per-field lookup, zero overhead for existing callers.
 */

/**
 * How to render a masked field:
 * - `full`  → replace the whole value with `*****`.
 * - `last4` → `****` + the last 4 characters of the value, e.g. `****9f0e`. Enough to correlate two
 *   tokens across a trace without disclosing either. Values of 4 chars or fewer render as `****` with
 *   NO tail, so a short secret is never leaked in full.
 */
export type MaskMode = 'full' | 'last4';

/** The literal `*****` written for a `full` mask, and the fixed prefix of a `last4` mask. */
const FULL_MASK = '*****';
const LAST4_PREFIX = '****';

/**
 * MaskSpec - the per-api/method declaration of which DTO fields are sensitive and how to render them,
 * plus the {@link stringify} that applies them.
 *
 * Matching is BY FIELD NAME AT ANY DEPTH: a field named `refreshToken` is masked whether it sits at
 * the top level, nested one or more objects down, or inside an array element. The real production leak
 * that motivated this was at `response.account.refreshToken` — one level down — so a top-level-only
 * filter would not have caught it.
 *
 * Per CLAUDE.md: data-only structures are classes, not interfaces. The constructor takes a plain
 * `{ fieldName: mode }` config map (declarative data, mirroring @Endpoint's options), e.g.
 * `new MaskSpec({ refreshToken: 'full', accessToken: 'last4', credential: 'full' })`.
 */
export class MaskSpec {
    private readonly fields: Map<string, MaskMode>;

    constructor(fields: Record<string, MaskMode>) {
        this.fields = new Map(Object.entries(fields));
    }

    /** The mask mode for a field name, or undefined if the field is not sensitive. */
    modeFor(fieldName: string): MaskMode | undefined {
        return this.fields.get(fieldName);
    }

    /**
     * `JSON.stringify` a value with every field named in this spec masked, at any depth.
     *
     * Uses a stringify REPLACER, which JSON.stringify invokes for every property at every level (and
     * for every array element's own properties) — that is what gives "by field name at any depth" for
     * free, including inside arrays. The replacer only ever READS the source and returns a substitute
     * string, so the original DTO is never mutated: the value the transport later serializes onto the
     * wire is unchanged. When a masked field is itself an object, returning a primitive string
     * short-circuits recursion into it, so nested secrets under a `full`-masked object cannot leak
     * either.
     *
     * Returns `undefined` for an undefined input (mirroring `JSON.stringify(undefined)`), so a masked
     * `Promise<void>` response has no body to measure, exactly as the unmasked path.
     */
    // webpieces-disable no-any-unknown -- serializes an arbitrary DTO whose type is erased at the api/proxy boundary
    stringify(value: unknown): string | undefined {
        // webpieces-disable no-any-unknown -- JSON.stringify replacer receives arbitrary node values
        return JSON.stringify(value, (key: string, val: unknown) => {
            // The root value is visited first with key '' — never a real field, so never masked.
            const mode = key === '' ? undefined : this.modeFor(key);
            return mode === undefined ? val : this.maskValue(val, mode);
        });
    }

    /**
     * Render one field's value according to its mask mode. Null/undefined pass through unchanged (there
     * is nothing to disclose); a non-string value under `last4` is treated as `full` (a last-4 tail only
     * makes sense for a string, and coercing an object would risk leaking part of it).
     */
    // webpieces-disable no-any-unknown -- masks one arbitrary DTO field value, type erased at the boundary
    private maskValue(value: unknown, mode: MaskMode): string | null | undefined {
        if (value === null || value === undefined) {
            return value;
        }
        if (mode === 'full' || typeof value !== 'string') {
            return FULL_MASK;
        }
        if (value.length <= 4) {
            return LAST4_PREFIX;
        }
        return LAST4_PREFIX + value.slice(-4);
    }
}
