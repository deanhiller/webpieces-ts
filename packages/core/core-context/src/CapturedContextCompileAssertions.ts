import { CapturedContext, ContextCaptureAuthority, RestorableContext } from './CapturedContext';
import { RequestContext } from './RequestContext';

/**
 * COMPILE-TIME assertions that a context can only be restored from a REAL capture.
 *
 * The runtime half — that a snapshot round-trips, and that mutating the source afterwards does not
 * reach it — is in `CapturedContext.spec.ts`. What a spec CANNOT express is the half that matters
 * most: that `RequestContext.restoreContext(new Map([['userId', 'victim']]))` does not compile. Each
 * `@ts-expect-error` below fails the build with TS2578 the day its line starts compiling again.
 *
 * In COMPILED source deliberately — `tsconfig.lib.json` excludes specs and vitest strips types with
 * esbuild, so a `@ts-expect-error` in a `.spec.ts` is inert and the suite would pass either way. See
 * `RequestContextTrustCompileAssertions` for the trust-verb half.
 */
export class CapturedContextCompileAssertions {
    /** THE hole this change closes: a hand-assembled payload forging a trusted value. */
    cannotRestoreAHandBuiltMap(): void {
        // @ts-expect-error - restoreContext takes an opaque CapturedContext, never a raw Map
        RequestContext.restoreContext(new Map([['userId', 'victim']]));
    }

    /** Same hole through the other door. */
    cannotRunWithAHandBuiltMap(): void {
        // @ts-expect-error - runWithContext takes an opaque CapturedContext, never a raw Map
        RequestContext.runWithContext(new Map([['userId', 'victim']]), () => undefined);
    }

    /** Nor by asserting an object literal into the shape — the private `#entries` makes it nominal. */
    cannotFakeTheShape(): void {
        // @ts-expect-error - an object literal is not a CapturedContext; #entries is not satisfiable
        const forged: CapturedContext = { size: () => 1 };
        void forged;
    }

    /** Nor by constructing one directly — the constructor is private. */
    cannotConstructOneDirectly(): void {
        // @ts-expect-error - the constructor is private; copyContext() is the only producer
        const forged = new CapturedContext(new Map([['userId', 'victim']]));
        void forged;
    }

    /**
     * Nor by calling the factory: it demands a capability token whose own constructor is private, so
     * even code that can NAME the token (this package) cannot mint a second one.
     */
    cannotMintAnAuthority(): void {
        // @ts-expect-error - ContextCaptureAuthority's constructor is private; INTERNAL is the only one
        const forgedAuthority = new ContextCaptureAuthority();
        void forgedAuthority;
    }

    /** And the factory is not callable without one at all. */
    cannotCaptureWithoutAnAuthority(): void {
        // @ts-expect-error - capture() requires a ContextCaptureAuthority as its first argument
        CapturedContext.capture(new Map([['userId', 'victim']]));
    }

    /**
     * THE new hole this pair closes: a BARE capture must not run. If it did, `runWithContext(snapshot,
     * fn)` would sit next to `runWithContext(snapshot.withTrusted(), fn)` as a second spelling whose
     * shorter form silently carries a user identity — a widening that is an absence rather than a
     * token, and ungreppable. The capture is inert until it states its intent.
     */
    cannotRunABareCapture(): void {
        const captured: CapturedContext = RequestContext.copyContext();
        // @ts-expect-error - runWithContext takes a RestorableContext: say withTrusted() or withoutTrusted()
        RequestContext.runWithContext(captured, () => undefined);
    }

    /** Same, through the in-place door. */
    cannotRestoreABareCapture(): void {
        const captured: CapturedContext = RequestContext.copyContext();
        // @ts-expect-error - restoreContext takes a RestorableContext: say withTrusted() or withoutTrusted()
        RequestContext.restoreContext(captured);
    }

    /**
     * And the intent is stated by NARROWING, never by a flag on the run call. A `keepTrusted: boolean`
     * would make the wide intent as easy to type as the narrow one and impossible to grep; this line
     * fails the build the day such a parameter appears.
     */
    cannotStateTheIntentViaAFlagOnTheRunCall(): void {
        const captured: RestorableContext = RequestContext.copyContext().withTrusted();
        // @ts-expect-error - there is no third parameter; narrow the snapshot instead
        RequestContext.runWithContext(captured, () => undefined, false);
    }

    /** Nor can a narrowed snapshot be minted directly — same private constructor, same token. */
    cannotConstructARestorableContextDirectly(): void {
        // @ts-expect-error - the constructor is private; withTrusted()/withoutTrusted() are the producers
        const forged = new RestorableContext(new Map([['userId', 'victim']]));
        void forged;
    }

    /** Nor through its factory, which demands the same unobtainable authority. */
    cannotMintARestorableContextWithoutAnAuthority(): void {
        // @ts-expect-error - of() requires a ContextCaptureAuthority as its first argument
        RestorableContext.of(new Map([['userId', 'victim']]));
    }

    /** POSITIVE: both narrowings produce the ONE type both consumers take. */
    bothNarrowingsFeedBothConsumers(): void {
        const captured: CapturedContext = RequestContext.copyContext();
        const wide: RestorableContext = captured.withTrusted();
        const dropped: RestorableContext = captured.withoutTrusted();
        RequestContext.runWithContext(wide, () => {
            RequestContext.restoreContext(dropped);
        });
    }

    /** POSITIVE: the real round trip must keep compiling — restoring a proven value IS the point. */
    theRealRoundTripCompiles(): void {
        const captured: RestorableContext = RequestContext.copyContext().withTrusted();
        RequestContext.runWithContext(captured, () => {
            RequestContext.restoreContext(captured);
        });
    }
}
