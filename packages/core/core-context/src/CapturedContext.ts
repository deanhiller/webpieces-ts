import { HeaderRegistry } from '@webpieces/core-util';

/**
 * A capability TOKEN, not data — the thing you must be holding to build a {@link CapturedContext} or
 * to unpack one.
 *
 * It exists because `CapturedContext` needs a producer that {@link RequestContext} (a different class,
 * in a different file) can call, and TypeScript's `private` is class-scoped: a plain public
 * `CapturedContext.capture(map)` would be exactly the hand-assembled-payload hole this class exists to
 * close. So the producer takes a token whose constructor is private and whose only instance is
 * {@link INTERNAL}, and this module is deliberately NOT re-exported from the package barrel — in any
 * form, type or value.
 *
 * On its own that stops a consumer NAMING the token but not SUPPLYING one, since `null as never`
 * type-checks. It is the barrel's `export type { CapturedContext }` that finishes the job: with no
 * class object on the package surface there is no `capture(...)` to call, cast or not. The two halves
 * are load-bearing together, which is why each names the other.
 *
 * Per CLAUDE.md this is a class rather than a `Symbol` or an object literal: it is nominal (the private
 * `brand` field stops a structurally-identical `{}` from satisfying it) and it has exactly one
 * instantiation point.
 */
export class ContextCaptureAuthority {
    /**
     * Nominal brand. Without a private member the class is structurally `{}`, and any object at all
     * would typecheck as an authority.
     */
    private readonly brand: string = 'webpieces.context-capture';

    /** The ONE token that exists. The constructor below is private, so no other can be made. */
    static readonly INTERNAL = new ContextCaptureAuthority();

    private constructor() {}

    /** Kept honest — the brand is read here so it is a real field, not a type-only fiction. */
    describe(): string {
        return this.brand;
    }
}

/**
 * CapturedContext — an OPAQUE snapshot of a {@link RequestContext} scope.
 *
 * ## THE THREE CASES — pick by where the values came from and what may keep the identity
 *
 * | you have | you want | write |
 * |---|---|---|
 * | a genuine prior scope | ALL of it, trusted values included | `runWithContext(snapshot.withTrusted(), fn)` |
 * | a genuine prior scope | the trace fields but NOT the identity | `runWithContext(snapshot.withoutTrusted(), fn)` |
 * | values from OUTSIDE this process | exactly what you re-state, nothing inherited | `RequestContext.runDetachedScope(fn)` |
 *
 * Row 1 is a faithful re-root of a broken async chain — the work continues AS that user. Row 2 is a
 * deliberate PRIVILEGE DROP: a background job keeps `requestId`/`actionId` so it stays greppable, and
 * loses `userId`/`orgId`/roles because it runs as the system (see {@link withoutTrusted}). Row 3 is a
 * different question entirely — the values were never in a scope here, so there is no snapshot to take;
 * see `RequestContext.runDetachedScope`, where each value is written inside the closure with the trust
 * verbs.
 *
 * There is NO bare form of rows 1 and 2. `copyContext()` hands back a `CapturedContext`, and
 * `runWithContext`/`restoreContext` do not accept one — they take the {@link RestorableContext} that
 * {@link withTrusted} and {@link withoutTrusted} produce. Every call site therefore STATES whether the
 * proven identity travels, and neither intent is shorter to type than the other. That is CLAUDE.md shim
 * shape #5 applied here: a bare snapshot silently carrying a user identity is a widening that is an
 * absence rather than a token, and it is ungreppable. Now `grep -rn withTrusted` enumerates every place
 * an identity crosses a scope boundary and `grep -rn withoutTrusted` every deliberate drop.
 *
 * ## What it is for
 *
 * `AsyncLocalStorage` follows `await`, `.then()` and ordinary callbacks on its own, so the vast
 * majority of code never needs this. What it does NOT follow is work whose async chain was BROKEN and
 * re-rooted somewhere else: an item pushed onto an in-memory queue during a request and drained later
 * by a background loop, a batch flushed on a scheduler tick, an `EventEmitter` listener fired from a
 * socket the request does not own, a retry re-armed from a top-level timer, a hand-off to a worker
 * pool. In each of those the work executes under a DIFFERENT (or no) context, so the request id, the
 * log fields and the proven identity would silently vanish from everything the work logs or calls.
 *
 * The answer is two halves: `RequestContext.copyContext()` where the work is ENQUEUED, and
 * `RequestContext.runWithContext(captured.withTrusted(), fn)` — or `.withoutTrusted()`, or
 * `restoreContext(...)` of either — where it RUNS. The narrowing is not optional; see the table above.
 *
 * ## Why it is opaque instead of a `Map<string, unknown>`
 *
 * A restored context legitimately contains TRUSTED values — reinstating what the original scope had
 * proven is the entire point — so the restore side cannot type-check its payload the way
 * `putTrusted`/`getTrusted` do. That left the `Map`-taking signature that this class DELETED (a
 * now-removed `setContext(map)`, and `runWithContext(map, fn)`) as a complete bypass of the trust
 * system: handing it `new Map([['userId', 'victim']])` forged a proven identity in one line, without
 * ever typing a trust verb, and the only thing standing against it was a doc comment saying "the Map
 * must come from copyContext()". An agent picks whatever compiles, so a doc comment is not
 * enforcement.
 *
 * Making the PAYLOAD opaque solves it without type-checking the contents: the only way to obtain one is
 * a real capture of a real scope, so whatever it holds was, by construction, already in a context that
 * something legitimately wrote. Concretely:
 *
 * - the constructor is `private`, and there is no public factory — {@link capture} demands a
 *   {@link ContextCaptureAuthority} that cannot be named outside this package;
 * - the package barrel exports this class as a TYPE ONLY, so a consumer never receives the class
 *   object at all and cannot reach `capture` even with a cast. That second half matters: a token whose
 *   TYPE is unexported still stops nothing on its own, because `capture(null as never, forgedMap)`
 *   type-checks. Withholding the class object is what actually closes it;
 * - the entries live in `#entries`, a genuine ECMAScript private field, so they are unreachable at
 *   RUNTIME as well as at compile time — no `Object.keys`, no cast, no index signature;
 * - the map is defensively copied ON CAPTURE, again on each NARROWING, and again ON RESTORE, so a
 *   caller who still holds the live context (or who keeps writing to it after capturing) cannot reach
 *   through the snapshot, narrowing never mutates the capture it came from, and a snapshot can be
 *   restored repeatedly without the first restore's mutations bleeding into the second.
 *
 * There is deliberately no reader: nothing hands the entries back out. That is why `getAll()` is gone
 * rather than re-typed to return one of these — a `CapturedContext` you cannot read is useless as a
 * `getAll`, and a readable one would be the raw enumeration of every trusted value all over again.
 *
 * The one residual: a consumer holding a NARROWED snapshot can still cast a token into
 * {@link RestorableContext.toFreshStore} and read the entries back out as a plain Map. That is knowingly accepted, and it is the same asymmetry
 * `RequestContext.getAny` states — FORGING a trusted value is the dangerous direction and is closed
 * here; reading one you were already legitimately handed, without saying `getTrusted`, costs you
 * nothing but the type. Closing it too would mean no method could take the token at all, which is to
 * say no restore could exist.
 */
export class CapturedContext {
    /**
     * A real ECMAScript private field, not a TypeScript `private`. The distinction matters here: `#`
     * is enforced by the runtime, so the snapshot's contents cannot be reached by a cast, by
     * `Object.entries`, or by `as unknown as { entries: Map<string, unknown> }`.
     */
    // webpieces-disable no-any-unknown -- the context store is deliberately type-erased; each ContextKey carries its own value type and the typed verbs re-apply it on read
    readonly #entries: Map<string, unknown>;

    /**
     * PRIVATE — a CapturedContext can only come from {@link capture}, which in turn can only be called
     * by code holding a {@link ContextCaptureAuthority}. Copies the map so the snapshot is never a
     * window onto a live store.
     */
    // webpieces-disable no-any-unknown -- see #entries
    private constructor(entries: Map<string, unknown>) {
        this.#entries = new Map(entries);
    }

    /**
     * The ONLY producer. `authority` is a compile-time capability, not a runtime check — so it is
     * referenced below only to keep it from being an unused parameter. Note the token alone is not the
     * guarantee (a cast can supply one); the guarantee is that the barrel exports this class as a TYPE
     * ONLY, so no consumer ever holds the class object this static hangs off. See the class doc.
     */
    // webpieces-disable no-any-unknown -- see #entries
    // webpieces-disable no-function-outside-class -- static factory standing in for the (private) constructor; making it an instance method would mean an instance already existed, which is the thing being created
    static capture(authority: ContextCaptureAuthority, live: Map<string, unknown>): CapturedContext {
        void authority;
        return new CapturedContext(live);
    }

    /**
     * Carry EVERY value onward, the proven identity included — the faithful re-root. The work runs AS
     * that user: `getTrusted(USER_ID)` inside it answers exactly what it answered in the original scope,
     * which is the entire point when a request's own continuation was re-rooted onto a queue or a timer.
     *
     * Said OUT LOUD, because it is the wide branch. A bare snapshot is deliberately not accepted by
     * `runWithContext`/`restoreContext` (see the class doc), so the identity never crosses a scope
     * boundary by default or by omission, and `grep -rn withTrusted` enumerates every place it does.
     *
     * NON-MUTATING, like its sibling — the receiver is unchanged, so ONE snapshot can be narrowed both
     * ways at two different call sites.
     */
    withTrusted(): RestorableContext {
        return RestorableContext.of(ContextCaptureAuthority.INTERNAL, this.#entries);
    }

    /**
     * Carry only the UNTRUSTED values — a deliberate PRIVILEGE DROP.
     *
     * ```typescript
     * const snapshot = RequestContext.copyContext();
     * RequestContext.runWithContext(snapshot.withTrusted(), fn);     // runs AS that user
     * RequestContext.runWithContext(snapshot.withoutTrusted(), fn);  // runs as the SYSTEM
     * ```
     *
     * The case: a background job or fire-and-forget task spawned during a request should keep the
     * untrusted trace fields — `requestId`, `actionId` — so its log lines are still greppable back to
     * the click that caused them, but it must NOT keep `userId` / `orgId` / roles, because it executes
     * as the system rather than as that user. Carrying the proven identity onward would make every
     * downstream authorization decision think the user is still on the other end of the wire.
     *
     * A METHOD PAIR, never a `keepTrusted: boolean` on {@link RequestContext.runWithContext}: a
     * parameter makes the two intents equally easy to type and impossible to grep, and a defaulted one
     * makes the permissive branch the shortest thing to write — CLAUDE.md shim shape #5, "a widening
     * that is an ABSENCE rather than a token", the same reason `@AuthJwt({allRolesAllowed: true})` says
     * the wide grant out loud. As a transform on the SNAPSHOT rather than a second capture mechanism it
     * composes with BOTH consumers — `runWithContext` and `restoreContext` — for free.
     *
     * NON-MUTATING: the receiver is untouched, so one snapshot can be used both ways.
     *
     * NO AUTHORITY TOKEN, deliberately, and it must not grow one. The token on {@link capture} exists
     * because CONSTRUCTING a snapshot from arbitrary entries forges trust. This direction only ever
     * REMOVES entries: whatever survives was already in a real capture of a real scope, so the result
     * is strictly less privileged than the object the caller is already holding. Dropping cannot forge.
     *
     * WHAT SURVIVES is exactly "registered as an UNTRUSTED {@link ContextKey}". Trusted keys go, and so
     * do names the {@link HeaderRegistry} does not know — the framework's reserved slots (the
     * `HttpRequest`, the AuthFilter principal, the Cloud Tasks schedule frame), which carry no declared
     * trust and are the caller's identity and connection rather than trace fields. A privilege drop
     * that guessed in the permissive direction would not be one. For the same reason, with no registry
     * configured NOTHING is knowably untrusted and the result is empty — always the safe answer, since
     * this method's only job is to remove.
     */
    withoutTrusted(): RestorableContext {
        // webpieces-disable no-any-unknown -- the context store is deliberately type-erased; see #entries
        const kept = new Map<string, unknown>();
        if (!HeaderRegistry.isConfigured()) {
            return RestorableContext.of(ContextCaptureAuthority.INTERNAL, kept);
        }
        const registry = HeaderRegistry.get();
        for (const name of this.#entries.keys()) {
            const key = registry.findByName(name);
            if (key && !key.isTrusted()) {
                kept.set(name, this.#entries.get(name));
            }
        }
        return RestorableContext.of(ContextCaptureAuthority.INTERNAL, kept);
    }

    /**
     * How many entries the snapshot holds. The one thing it will tell you about itself — a count is
     * not a value, so it leaks nothing, and it lets a caller (and a test) see that a capture taken
     * outside an active scope is simply empty rather than an error.
     */
    size(): number {
        return this.#entries.size;
    }
}

/**
 * A snapshot whose TRUST INTENT has been stated — the only thing `RequestContext.restoreContext` and
 * `RequestContext.runWithContext` accept.
 *
 * It exists to make the wide choice unskippable. A single type would have meant
 * `runWithContext(snapshot, fn)` compiling next to `runWithContext(snapshot.withTrusted(), fn)`: two
 * spellings of one thing (shim shape #1), with the shorter one silently carrying a user identity into
 * work that may have no business running as that user. Splitting the type deletes the default — a
 * capture is inert until it says which it means — so there is exactly one spelling per intent, and
 * `grep -rn withTrusted` / `grep -rn withoutTrusted` enumerate the two populations of call sites.
 *
 * Two CLASSES rather than a phantom type parameter on {@link CapturedContext}, even though this repo
 * uses that trick on `ContextKey<V, T extends Trust>`. There the parameter rides along with a key that
 * consumers name constantly and read values through, so it earns its complexity. Here the two states
 * have DIFFERENT MEMBERS — a capture can only be narrowed, a narrowed one can only be restored — and a
 * type that changes its members between states is a second class, not a second type argument. Naming
 * it also gives the field/queue-entry type a consumer holds a name that says what it is.
 *
 * The #622 opacity guarantees are unchanged and are why this class is also barrel-exported as a TYPE
 * ONLY: private constructor, a capability token on the producer, a real `#entries` private field, and
 * defensive copies on the way in and on the way out.
 */
export class RestorableContext {
    /** Same real ECMAScript private field, for the same reason — see {@link CapturedContext}. */
    // webpieces-disable no-any-unknown -- the context store is deliberately type-erased; each ContextKey carries its own value type and the typed verbs re-apply it on read
    readonly #entries: Map<string, unknown>;

    /** PRIVATE — {@link of} is the only producer, and only this module can call it. */
    // webpieces-disable no-any-unknown -- see #entries
    private constructor(entries: Map<string, unknown>) {
        this.#entries = new Map(entries);
    }

    /**
     * The ONLY producer, called by `CapturedContext.withTrusted()` / `withoutTrusted()`. Guarded the
     * same way `capture` is: a token no consumer can name, and a barrel that exports this class as a
     * TYPE ONLY, so the class object — and with it this static — never reaches a consumer at all.
     */
    // webpieces-disable no-any-unknown -- see #entries
    // webpieces-disable no-function-outside-class -- static factory standing in for the (private) constructor; an instance method would presuppose the instance being created
    static of(authority: ContextCaptureAuthority, entries: Map<string, unknown>): RestorableContext {
        void authority;
        return new RestorableContext(entries);
    }

    /**
     * Overwrite a LIVE store with this snapshot — the engine behind `RequestContext.restoreContext`.
     * Write-only by design: it pushes entries in and hands nothing back, so it is not a side door onto
     * the snapshot's contents.
     */
    // webpieces-disable no-any-unknown -- see #entries
    restoreInto(authority: ContextCaptureAuthority, live: Map<string, unknown>): void {
        void authority;
        live.clear();
        for (const name of this.#entries.keys()) {
            live.set(name, this.#entries.get(name));
        }
    }

    /**
     * A FRESH store holding this snapshot — the engine behind `RequestContext.runWithContext`, which
     * opens a new AsyncLocalStorage scope around it. Fresh (a copy) rather than the internal map, so
     * everything the restored scope writes stays in that scope and the snapshot remains reusable.
     */
    // webpieces-disable no-any-unknown -- see #entries
    toFreshStore(authority: ContextCaptureAuthority): Map<string, unknown> {
        void authority;
        return new Map(this.#entries);
    }

    /** How many entries survived the narrowing. A count is not a value, so it leaks nothing. */
    size(): number {
        return this.#entries.size;
    }
}
