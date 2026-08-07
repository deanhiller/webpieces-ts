import { ContextKey, AnyContextKey } from './ContextKey';

/**
 * COMPILE-TIME assertions that the trust system cannot be bypassed by writing the wrong thing.
 *
 * Every `@ts-expect-error` below FAILS THE BUILD (TS2578, "unused '@ts-expect-error' directive") the
 * day its line starts compiling — so this file is a tripwire, not documentation that can rot.
 *
 * It lives in COMPILED source, never in a `.spec.ts`, and that placement is load-bearing:
 * `tsconfig.lib.json` excludes specs and vitest strips types with esbuild, so a `@ts-expect-error`
 * in a spec is inert and the suite would pass either way. See the same pattern in
 * `AuthJwtCompileAssertions.ts`.
 *
 * The verb-level assertions (`getTrusted` refusing an untrusted key, and vice versa) live in
 * core-context beside `RequestContext`, which is where those verbs are declared.
 */
export class ContextKeyTrustCompileAssertions {
    /** A trusted key MUST state its provenance — "trusted because reasons unstated" is unwritable. */
    trustedRequiresProvenance(): void {
        // @ts-expect-error - provenance is required on ContextKey.trusted
        ContextKey.trusted<string>('userId');
    }

    /**
     * There is NO public constructor. A key cannot exist without picking a trust branch, so trust can
     * never be defaulted, forgotten, or silently widened by an omitted argument.
     */
    noConstructorEscapeHatch(): void {
        // @ts-expect-error - the constructor is private; use ContextKey.trusted / ContextKey.untrusted
        new ContextKey<string>('userId', 'trusted', undefined, 'x-user-id', false, true);
    }

    /**
     * The two branches are NOT interchangeable types. This is what makes `getTrusted(SOME_UNTRUSTED)`
     * a compile error rather than a runtime throw — assigning one to the other must not typecheck.
     */
    branchesAreNotInterchangeable(): void {
        const untrusted: ContextKey<string, 'untrusted'> = ContextKey.untrusted<string>('actionId');
        // @ts-expect-error - an untrusted key is not a trusted key
        const asTrusted: ContextKey<string, 'trusted'> = untrusted;
        void asTrusted;

        const trusted: ContextKey<string, 'trusted'> = ContextKey.trusted<string>('userId', 'jwt claim');
        // @ts-expect-error - a trusted key is not an untrusted key
        const asUntrusted: ContextKey<string, 'untrusted'> = trusted;
        void asUntrusted;
    }

    /**
     * BOTH branches must still flow into the mixed-bag alias, or the registry's key arrays
     * (`ALL_HEADERS`, `getLoggedKeys()`, `getTransferredKeys()`) would stop compiling. This one is a
     * POSITIVE assertion: it must keep working.
     */
    bothBranchesAreAnyContextKey(): void {
        const keys: AnyContextKey[] = [
            ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id'),
            ContextKey.untrusted<string>('actionId', 'x-webpieces-actionid'),
        ];
        void keys;
    }
}
