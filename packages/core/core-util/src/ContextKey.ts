/**
 * ContextKey - a single key that travels in the request's "magic context"
 * (RequestContext on the server, MutableContextStore in the browser).
 *
 * This ONE class replaces the old split of `Header` (interface) + `PlatformHeader`
 * (class) + `ContextKey` (class). Every context value — whether it rides over HTTP
 * (request-id, tenant, authorization) or stays in-process (method-meta, the
 * TestCaseRecorder) — is a `ContextKey`.
 *
 * The fields are named for what they DO (flipped from the old model):
 * - `name`        ALWAYS set. The context storage key, the log/MDC key, and the
 *                 recorder name. e.g. 'requestId', 'tenantId', 'authorization'.
 * - `httpHeader`  OPTIONAL. When set, this key is transferred over the wire under
 *                 this HTTP header name (inbound request -> context, and context ->
 *                 outbound request). e.g. 'x-request-id'. When UNSET, the key is
 *                 context-only and never leaves the process (method-meta, recorder).
 * - `trust`       REQUIRED, and stated by WHICH FACTORY you call. See below.
 * - `maskInLogs`  When true, the value is masked (partially) in logs. This is about
 *                 LOG REDACTION and has NOTHING to do with `trust` — a userId is
 *                 trusted AND fully logged; a bearer token is untrusted AND masked.
 *                 (Formerly `isSecured`, renamed because sitting next to `trust` the
 *                 old name read as "this value is secure", which it never meant.)
 * - `isLogged`    Defaults to true. When false, the value is NEVER logged (used for
 *                 object-valued/internal keys like the recorder or method-meta that
 *                 must not be serialized into log lines).
 *
 * ## TRUST — the whole point of this class
 *
 * A context value is either something the framework PROVED (`trusted`) or something a
 * caller merely ASSERTED (`untrusted`). That distinction is invisible in a `Map<string,
 * string>`, so code — human- or AI-written — routinely reads a spoofable header as if it
 * were an authenticated fact. `userId` is the canonical example: it is a verified JWT
 * claim on one route and an attacker-supplied `x-user-id` on the next, and nothing in the
 * old API told them apart.
 *
 * So trust is declared ON THE KEY, at the single place the key is defined, and it is
 * enforced at BOTH ends:
 *
 *   ContextKey.trusted<string>('userId', 'jwt claim `sub`, stamped by AuthFilter', 'x-user-id')
 *   ContextKey.untrusted<string>('actionId', 'x-webpieces-actionid')
 *
 * `grep -rn "ContextKey.trusted"` therefore enumerates every high-assurance field in the
 * codebase, each with its `provenance` string on the same line saying WHY it is trusted.
 * That is the AI-facing payoff: the answer is one grep, not an audit.
 *
 * The constructor is PRIVATE — you cannot make a key without picking a branch, and there
 * is no default. A default would make the permissive branch the shortest thing to type,
 * which is exactly the "widening that is an ABSENCE rather than a token" that CLAUDE.md
 * rejects. `provenance` is a REQUIRED positional argument on the trusted factory only, so
 * "trusted with no stated reason" cannot be written down.
 *
 * ## What makes the `trusted` label HONEST at runtime
 *
 * The label would be a lie if anything could write a trusted key from an unverified
 * source. Three enforced facts prevent that:
 *
 * 1. WRITES are typed: only `RequestContext.putTrusted(key, value)` accepts a trusted key,
 *    and it is a distinct, greppable verb an app has to type on purpose.
 * 2. INBOUND wire values for trusted keys never enter the context directly.
 *    `RequestContextHeaders.fillFromRequest` stashes them as PENDING, and `AuthFilter`
 *    admits them only after it knows who the caller is (see {@link PendingWireTrust}).
 * 3. READS are typed: `getTrusted(key)` does not compile for an untrusted key, and
 *    `getUntrusted(key)` does not compile for a trusted one. Picking a verb is
 *    unavoidable, so a reader always knows which kind of value it is holding.
 *
 * Trusted keys DO keep their `httpHeader` — service-to-service propagation of a verified
 * userId is a first-class requirement, not a hole. It is safe because rule 2 gates it on
 * the endpoint's own auth mode: a route that verified WHO called it (`@AuthOidc`,
 * `@AuthSharedSecret`) accepts the caller's trusted headers; a route reachable by a
 * browser (`@AuthJwt`, public) does not.
 *
 * Per CLAUDE.md: data-only structures are classes, not interfaces.
 *
 * The type parameter `V` is the TYPE OF THE VALUE stored under this key — `string` for the wire/log
 * keys (requestId, tenantId, ...), `ApiCallInfo` for the structured api tag, `TestCaseRecorder` for
 * the recorder. It is REQUIRED (no default): every key must state what it holds. A heterogeneous
 * store CANNOT be a `Record<string, string>` — the recorder and the api payload are not strings — so
 * instead each KEY carries its own value type, and the typed accessors INFER it from the key. That
 * keeps the backing Map honestly type-erased while the public surface stays fully typed: a caller
 * never asserts a value type, the key already declares it. A genuinely mixed collection of keys is
 * spelled explicitly as `AnyContextKey[]`, so "I mean a mixed bag" is a visible, deliberate
 * statement, never a default.
 *
 * The type parameter `T` is the TRUST LEVEL, carried as a phantom type so the accessor verbs can
 * reject the wrong kind of key at COMPILE time rather than throwing at runtime (CLAUDE.md treats a
 * runtime throw standing in for an expressible type as a defect).
 */

/** The two kinds of context value. See the {@link ContextKey} class doc. */
export type Trust = 'trusted' | 'untrusted';

/**
 * A trusted key of any value type — what {@link ContextTuple} carries, and what the trusted write
 * verb accepts when the value type is not statically known.
 */
// webpieces-disable no-any-unknown -- the ONE sanctioned `unknown`: a key whose value type is deliberately unconstrained (mixed-bag collections / key-agnostic code). Every other site names one of these aliases instead of repeating it.
export type AnyTrustedContextKey = ContextKey<unknown, 'trusted'>;

/**
 * An untrusted key of any value type — what the {@link ApiCallContext} seam stamps, so that seam
 * cannot be used as a side door to forge a trusted value.
 */
// webpieces-disable no-any-unknown -- same sanctioned mixed-bag alias, narrowed to the untrusted branch
export type AnyUntrustedContextKey = ContextKey<unknown, 'untrusted'>;

/**
 * A ContextKey whose value type is intentionally UNCONSTRAINED — a "key of any value type". Use this
 * (never a bare `ContextKey`, which no longer compiles) for genuinely mixed-bag collections and
 * key-agnostic code: `ALL_HEADERS: AnyContextKey[]`, the {@link HeaderRegistry}'s key arrays, a
 * reader that takes whatever key it is handed. Naming the mixed case makes "I mean any key" a visible,
 * deliberate statement.
 *
 * It is a UNION of the two branches, not `ContextKey<unknown, Trust>`, and that is load-bearing rather
 * than cosmetic. Trust is BINARY, so `if (key.isTrusted())` should type BOTH of its branches — and it
 * does only against a union: TypeScript narrows the negative of a `this is X` predicate by dropping the
 * union constituents assignable to `X`, so the `else` here lands on {@link AnyUntrustedContextKey} and
 * goes straight to `putUntrusted` with no cast. Written as one type with a mixed `Trust` parameter
 * there would be nothing to drop, the `else` would stay mixed, and the class would need a second
 * `isUntrusted()` predicate to type the branch its own negative already decided — one runtime question
 * with two spellings, which is the shim shape CLAUDE.md rejects.
 *
 * Mixed in TRUST as well as in value type, so it is READ-ONLY territory: `getAny(key)` takes one, but
 * no WRITE verb does. A write must name the trust level, which is what keeps the `trusted` label
 * honest.
 */
export type AnyContextKey = AnyTrustedContextKey | AnyUntrustedContextKey;

export class ContextKey<V, T extends Trust = Trust> {
    /**
     * Phantom marker carrying the value type {@link V}. It has no runtime existence (`declare`, never
     * assigned) — it exists ONLY so the read verbs return `V` and the write verbs check `value`
     * against `V`, both inferred straight from the key. Optional, so `ContextKey<A>` stays assignable
     * to `AnyContextKey` (i.e. `ContextKey<unknown>`) — arrays of mixed keys keep working.
     */
    declare readonly __valueType?: V;

    /**
     * Phantom marker carrying the trust level {@link T} — the reason `getTrusted(SOME_UNTRUSTED_KEY)`
     * is a COMPILE error and not a runtime throw. Like `__valueType` it never exists at runtime; the
     * runtime answer is the {@link trust} field below, which the fill/reconcile path reads.
     */
    declare readonly __trust?: T;

    /** Context storage key + log/MDC key + recorder name. Always set. */
    readonly name: string;

    /**
     * HTTP header name when this key is transferred over the wire (e.g.
     * 'x-request-id'). Undefined = context-only, never transferred.
     */
    readonly httpHeader?: string;

    /** The runtime twin of the phantom {@link __trust}. See the class doc. */
    readonly trust: Trust;

    /**
     * WHY this key is trusted, in prose — 'jwt claim `sub`, stamped by AuthFilter', or
     * 'whatsapp webhook phone number -> user lookup'. Required on a trusted key, absent on an
     * untrusted one. It exists so that grepping the trusted keys also tells you what proves each
     * one, without opening another file.
     */
    readonly provenance?: string;

    /** Mask this value (partially) in logs. Log redaction only — unrelated to {@link trust}. */
    readonly maskInLogs: boolean;

    /** Whether this key is logged at all. Default true; false = never logged. */
    readonly isLogged: boolean;

    /**
     * PRIVATE — use {@link trusted} or {@link untrusted}. There is deliberately no way to build a key
     * without stating its trust level: a defaulted trust argument would make the permissive branch
     * the shortest thing to type and impossible to grep.
     */
    private constructor(
        name: string,
        trust: Trust,
        provenance: string | undefined,
        httpHeader: string | undefined,
        maskInLogs: boolean,
        isLogged: boolean,
    ) {
        this.name = name;
        this.trust = trust;
        this.provenance = provenance;
        this.httpHeader = httpHeader;
        this.maskInLogs = maskInLogs;
        this.isLogged = isLogged;
    }

    /**
     * A key whose value the framework PROVED — a verified JWT claim, or a fact an app derived from a
     * verified credential (a Twilio/WhatsApp webhook's signed phone number looked up to a userId).
     *
     * Only `RequestContext.putTrusted` can write one, only `RequestContext.getTrusted` can read one,
     * and an inbound wire value for one is held PENDING until `AuthFilter` knows who the caller is.
     *
     * @param provenance WHY it is trusted, in prose. Required — see {@link ContextKey.provenance}.
     */
    // webpieces-disable no-function-outside-class -- static factory replacing the (now private) constructor; the trust branch must be part of the call, not a defaulted argument
    static trusted<V>(
        name: string,
        provenance: string,
        httpHeader?: string,
        maskInLogs = false,
        isLogged = true,
    ): ContextKey<V, 'trusted'> {
        return new ContextKey<V, 'trusted'>(name, 'trusted', provenance, httpHeader, maskInLogs, isLogged);
    }

    /**
     * A key whose value is merely ASSERTED by whoever sent it — a browser-minted actionId, a
     * client-supplied recording flag, an in-process log tag. Perfectly fine to use; just never
     * an input to an authorization decision.
     *
     * This is the DEFAULT choice in the sense that most keys are this — but it is never the default
     * VALUE: you still type the word, so reading a key definition always tells you which it is.
     */
    // webpieces-disable no-function-outside-class -- static factory replacing the (now private) constructor; see trusted()
    static untrusted<V>(
        name: string,
        httpHeader?: string,
        maskInLogs = false,
        isLogged = true,
    ): ContextKey<V, 'untrusted'> {
        return new ContextKey<V, 'untrusted'>(name, 'untrusted', undefined, httpHeader, maskInLogs, isLogged);
    }

    /** True when this key is transferred over HTTP (has an httpHeader). */
    isTransferred(): boolean {
        return this.httpHeader !== undefined;
    }

    /**
     * True for a key built by {@link trusted}. Trust is BINARY, so this ONE predicate answers it in
     * both directions and there is deliberately no `isUntrusted()` twin. The RUNTIME check used by the
     * inbound fill and the AuthFilter reconciliation; ordinary application code should never need it,
     * because the typed verbs already made the decision at compile time.
     *
     * It is a TYPE PREDICATE, so BOTH branches are typed, with NO cast on either side: the `if` holds a
     * `ContextKey<V, 'trusted'>` for `putTrusted` / `PendingWireTrust.stash`, and the `else` holds a
     * `ContextKey<V, 'untrusted'>` for `putUntrusted`. The `else` types only because
     * {@link AnyContextKey} is a UNION of the two branches — see that alias for why the negative of a
     * predicate needs something to drop. Before this, every such site wrote `key as
     * AnyTrustedContextKey`; a cast is exactly the thing an agent copies to the one place it is not
     * warranted, so the runtime check produces the type it proves instead.
     *
     * That is what makes a loop over a mixed `AnyContextKey[]` — the {@link HeaderRegistry} arrays, a
     * browser-log payload re-stated into a detached scope — safe BY CONSTRUCTION: the loop can only
     * write a key whose trust it has just tested, and a trusted key cannot reach `putUntrusted` at all,
     * so a loop fed by a source that proves nothing cannot fabricate a proven value, and nobody has to
     * remember to filter. That is a limit on the SOURCE, not on the key: a trusted key is written all
     * the time via `putTrusted`, by an authenticator or by app code that proved the value out of band.
     */
    isTrusted(): this is ContextKey<V, 'trusted'> {
        return this.trust === 'trusted';
    }

    /**
     * The value as it should appear in a log line: returned as-is for a normal
     * key, partially masked when this key sets `maskInLogs`. Masking is length-based:
     * - Length > 15: first 3 + "..." + last 3
     * - Length 8-15: first 2 + "..."
     * - Length < 8: "<secure key too short to log>"
     */
    maskForLogs(value: string): string {
        if (!this.maskInLogs) {
            return value;
        }
        const len = value.length;
        if (len < 8) {
            return '<secure key too short to log>';
        } else if (len <= 15) {
            return `${value.substring(0, 2)}...`;
        } else {
            return `${value.substring(0, 3)}...${value.substring(len - 3)}`;
        }
    }
}
