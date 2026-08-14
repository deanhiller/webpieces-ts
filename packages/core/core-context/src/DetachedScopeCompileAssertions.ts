import { AnyContextKey, ContextKey } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * COMPILE-TIME assertions for {@link RequestContext.runDetachedScope}.
 *
 * The runtime half — that the detached scope starts empty, that the enclosing scope survives, that a
 * throw unwinds it — is in `DetachedScope.spec.ts`. What a spec CANNOT express is the half that makes
 * the browser-log path safe BY CONSTRUCTION rather than by remembering to filter:
 *
 *  - `runDetachedScope` has NO container-taking form, so the deleted `runWithContext(map, fn)` forgery
 *    path cannot come back through this door;
 *  - a loop over a mixed `AnyContextKey[]` cannot write ANY key until it has tested that key's trust;
 *  - and a TRUSTED key can never reach `putUntrusted`, so a browser — which proves nothing — cannot
 *    FABRICATE a proven value by naming `userId` in its payload. It is a compile error at the write,
 *    not a filter someone has to remember to write.
 *
 * That is about the SOURCE, not about the key. Writing a trusted key is ordinary and legitimate — see
 * {@link putTrustedIsLegitimateInsideADetachedScope} — whenever the caller has actually proven the
 * value. What cannot be written down is a claim of proof by code that has none.
 *
 * In COMPILED source deliberately — `tsconfig.lib.json` excludes specs and vitest strips types with
 * esbuild, so a `@ts-expect-error` in a `.spec.ts` is inert and the suite would pass either way. Each
 * one below fails the build with TS2578 the day its line starts compiling. See
 * `CapturedContextCompileAssertions` and `RequestContextTrustCompileAssertions` for the sibling halves.
 */
export class DetachedScopeCompileAssertions {
    private readonly trusted = ContextKey.trusted<string>('assertDetachedUserId', 'jwt claim `sub`');
    private readonly untrusted = ContextKey.untrusted<string>('assertDetachedActionId');

    /**
     * THE hole this whole shape exists to keep shut: no Map/object/array of entries may cross the
     * boundary. Values are written INSIDE the closure, through the trust verbs.
     */
    cannotHandItAContainerOfEntries(): void {
        // @ts-expect-error - runDetachedScope takes ONLY a closure; there is no map-taking form
        RequestContext.runDetachedScope(new Map([['userId', 'victim']]), () => undefined);
    }

    /** Nor a plain object of entries, which is the same hole spelled differently. */
    cannotHandItAnObjectOfEntries(): void {
        // @ts-expect-error - the single parameter is the closure, not a bag of values
        RequestContext.runDetachedScope({ userId: 'victim' });
    }

    /** A key of unknown trust cannot be written AT ALL — the branch is not optional. */
    cannotWriteAMixedKeyWithoutTestingItsTrust(key: AnyContextKey): void {
        RequestContext.runDetachedScope(() => {
            // @ts-expect-error - putUntrusted needs a key KNOWN to be untrusted; AnyContextKey is mixed
            RequestContext.putUntrusted(key, 'from-the-browser');
        });
    }

    /**
     * And a TRUSTED key cannot be LAUNDERED through the untrusted verb, detached or not — which is
     * what a caller with no proof would have to do, since `putTrusted` is the only other way in and
     * saying it is a deliberate, greppable claim.
     */
    cannotLaunderATrustedKeyThroughTheUntrustedVerb(): void {
        RequestContext.runDetachedScope(() => {
            // @ts-expect-error - putUntrusted does not accept a trusted key
            RequestContext.putUntrusted(this.trusted, 'browser-said-so');
        });
    }

    /**
     * POSITIVE, and the point the negative above must not be mistaken for: writing a TRUSTED value
     * inside a detached scope is ordinary and correct when the caller has actually proven it — the
     * signed-webhook case (Twilio/WhatsApp proves the phone number, the app looks up the userId), or a
     * verified JWT claim. `putTrusted` is the verb for exactly that, and a detached scope does not
     * change it. Trust is about tamper-resistance, not secrecy: a trusted `userId` is a plain,
     * fully-logged GUID; masking is the separate `maskInLogs` axis.
     */
    putTrustedIsLegitimateInsideADetachedScope(): void {
        RequestContext.runDetachedScope(() => {
            RequestContext.putTrusted(this.trusted, 'proven-out-of-band');
            const proven: string | undefined = RequestContext.getTrusted(this.trusted);
            void proven;
        });
    }

    /**
     * POSITIVE, and the shape the real consumer writes: emit one browser line under a fresh scope
     * rebuilt from an EXTERNAL payload, driven off the registry's logged keys.
     *
     * The `isTrusted()` skip is what a reader sees; the compiler is what enforces it. Delete the skip
     * and the write below stops compiling, because the key is mixed again and `putUntrusted` refuses
     * it — see {@link cannotWriteAMixedKeyWithoutTestingItsTrust}.
     */
    // webpieces-disable no-any-unknown -- the EXTERNAL payload is by definition untyped JSON off the wire; that is precisely why every value below is trust-branched and typeof-checked before it is written
    theBrowserLogLoopCompiles(loggedKeys: AnyContextKey[], payload: Record<string, unknown>): void {
        RequestContext.runDetachedScope(() => {
            for (const key of loggedKeys) {
                if (key.isTrusted()) {
                    // A browser cannot vouch for a proven fact. There is no write in this branch, and
                    // no cast that could produce one.
                    continue;
                }
                // Past the `continue`, the key is narrowed to the untrusted branch by the SAME
                // predicate — no second check, and no cast, to reach `putUntrusted`.
                const value = payload[key.name];
                if (typeof value === 'string') {
                    RequestContext.putUntrusted(key, value);
                }
            }
            RequestContext.putUntrusted(this.untrusted, 'click-7');
        });
    }

    /** The return value flows through, and an async closure is a promise the caller can await. */
    async returnValuesFlowThrough(): Promise<void> {
        const sync: string = RequestContext.runDetachedScope(() => 'done');
        const asyncResult: string = await RequestContext.runDetachedScope(async () => 'done');
        void sync;
        void asyncResult;
    }
}
