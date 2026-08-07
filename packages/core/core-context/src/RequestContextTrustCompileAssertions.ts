import { ContextKey } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * COMPILE-TIME assertions that the four trust verbs reject the wrong kind of key.
 *
 * This is the half of the guarantee that a runtime check could not give you: a reader cannot
 * accidentally treat a caller-asserted value as proven, because the call does not compile. Each
 * `@ts-expect-error` fails the build (TS2578) if its line ever starts compiling.
 *
 * In COMPILED source deliberately — a `@ts-expect-error` inside a `.spec.ts` is inert here
 * (tsconfig.lib.json excludes specs; vitest strips types with esbuild), so the tripwire would be a
 * no-op. See `ContextKeyTrustCompileAssertions` for the key-construction half.
 */
export class RequestContextTrustCompileAssertions {
    private readonly trusted = ContextKey.trusted<string>('assertUserId', 'jwt claim `sub`');
    private readonly untrusted = ContextKey.untrusted<string>('assertActionId');

    /** Reading an untrusted value as if it were proven is the bug this whole change exists to stop. */
    cannotReadUntrustedAsTrusted(): void {
        // @ts-expect-error - getTrusted does not accept an untrusted key
        RequestContext.getTrusted(this.untrusted);
    }

    /** And the reverse, so a call site always states which kind of value it believes it has. */
    cannotReadTrustedAsUntrusted(): void {
        // @ts-expect-error - getUntrusted does not accept a trusted key
        RequestContext.getUntrusted(this.trusted);
    }

    /** FORGERY: writing a trusted key through the untrusted verb must not compile. */
    cannotForgeTrustedViaUntrustedWrite(): void {
        // @ts-expect-error - putUntrusted does not accept a trusted key
        RequestContext.putUntrusted(this.trusted, 'attacker-supplied');
    }

    /** Claiming proof for an untrusted key must not compile either — trust is not a caller's choice. */
    cannotClaimProofForUntrustedKey(): void {
        // @ts-expect-error - putTrusted does not accept an untrusted key
        RequestContext.putTrusted(this.untrusted, 'whatever');
    }

    /** POSITIVE: the matching pairs must keep compiling, with the value type inferred from the key. */
    matchingVerbsCompile(): void {
        RequestContext.putTrusted(this.trusted, 'user-42');
        RequestContext.putUntrusted(this.untrusted, 'click-7');
        const a: string | undefined = RequestContext.getTrusted(this.trusted);
        const b: string | undefined = RequestContext.getUntrusted(this.untrusted);
        void a;
        void b;
    }

    /** The value type still comes from the key: a trusted string key rejects a number. */
    valueTypeStillEnforced(): void {
        // @ts-expect-error - the key declares string, so a number is not a valid value
        RequestContext.putTrusted(this.trusted, 42);
    }
}
