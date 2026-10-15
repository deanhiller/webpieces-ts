import { AuthMode, jwt, OidcAuthMethod, oidcSameProject, oidcSvcs } from './auth-mode';
import { WpAuth } from './decorators';

/**
 * COMPILE-TIME assertions for the two OIDC descriptors and the `oidc` member of the {@link AuthMode}
 * union. Each `@ts-expect-error` below FAILS THE BUILD (TS2578, "unused '@ts-expect-error' directive")
 * if the line it guards ever starts compiling.
 *
 * WHY THIS IS NOT A `.spec.ts` FILE — same reason as `WpAuthApiKeyCompileAssertions.ts`:
 * tsconfig.lib.json EXCLUDES specs and vitest strips types with esbuild, so a `@ts-expect-error` in a
 * spec is inert and the suite passes whether or not the guarded line really errors.
 *
 * WHAT IT PINS.
 *
 * 1. `oidcSvcs([...])` names AT LEAST ONE service account. The removed `oidc()` meant "any
 *    Google-signed caller" when it named nobody, so an empty list is a compile error here rather than
 *    a policy somebody could mistake for that grant (shim shape #4). `AuthDeclaration` keeps a runtime
 *    backstop only for a list that arrives around the type.
 * 2. The two scopes are MUTUALLY exclusive shapes: a same-project descriptor carries no `callers`, and
 *    a services descriptor cannot drop them.
 * 3. The removed shape, `{ kind: 'oidc', callers }` with no `callerScope`, no longer type-checks, so a
 *    hand-written mode cannot reintroduce the trust-the-edge grant through the union.
 * 4. One endpoint MAY pair one descriptor of each scope with other credentials. Two of one scope is a
 *    runtime refusal in `AuthDeclaration`: a tuple of union members cannot express "at most one each".
 */
export class WpAuthOidcCompileAssertions {
    /** The legitimate spellings must keep compiling; asserted by the ABSENCE of an error. */
    legitimate(): void {
        void WpAuth([oidcSameProject()]);
        void WpAuth([oidcSvcs(['self'])]);
        void WpAuth([oidcSvcs(['svc-a', 'partner-sa@other-project.iam.gserviceaccount.com'])]);
        void WpAuth([
            oidcSameProject(),
            oidcSvcs(['partner-sa@other-project.iam.gserviceaccount.com']),
            jwt(),
        ]);
    }

    rejected(): void {
        // @ts-expect-error an empty list names nobody; oidcSameProject() accepts this project's service accounts
        void oidcSvcs([]);
        // @ts-expect-error the service accounts are ONE list, not rest arguments
        void oidcSvcs('svc-a', 'svc-b');
        // @ts-expect-error a same-project descriptor takes no caller list
        void oidcSameProject(['svc-a']);
        // @ts-expect-error a same-project descriptor carries no callers
        const extra: OidcAuthMethod = { kind: 'oidc', callerScope: 'same-project', callers: ['a'] };
        void extra;
        // @ts-expect-error a services descriptor must carry its callers
        const missing: OidcAuthMethod = { kind: 'oidc', callerScope: 'services' };
        void missing;
        // @ts-expect-error the removed trust-the-edge shape (callers, no callerScope) is not an AuthMode
        const removedShape: AuthMode = { kind: 'oidc', callers: [] };
        void removedShape;
    }
}
