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
 * `RequestContext.runWithContext(captured, fn)` (or `restoreContext(captured)`) where it RUNS.
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
 * - the map is defensively copied ON CAPTURE and again ON RESTORE, so a caller who still holds the
 *   live context (or who keeps writing to it after capturing) cannot reach through the snapshot, and a
 *   snapshot can be restored repeatedly without the first restore's mutations bleeding into the second.
 *
 * There is deliberately no reader: nothing hands the entries back out. That is why `getAll()` is gone
 * rather than re-typed to return one of these — a `CapturedContext` you cannot read is useless as a
 * `getAll`, and a readable one would be the raw enumeration of every trusted value all over again.
 *
 * The one residual: a consumer holding a snapshot can still cast a token into `toFreshStore` and read
 * the entries back out as a plain Map. That is knowingly accepted, and it is the same asymmetry
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

    /**
     * How many entries the snapshot holds. The one thing it will tell you about itself — a count is
     * not a value, so it leaks nothing, and it lets a caller (and a test) see that a capture taken
     * outside an active scope is simply empty rather than an error.
     */
    size(): number {
        return this.#entries.size;
    }
}
