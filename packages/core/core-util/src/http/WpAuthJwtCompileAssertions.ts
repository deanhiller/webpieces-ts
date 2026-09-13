import { getAuthMeta, getAuthMode, WpAuthJwt } from './decorators';

/**
 * COMPILE-TIME assertions for `JwtRoles` — the guarantee that every broken role decision is a compile
 * error rather than a silent over-permissioning. Each `@ts-expect-error` below FAILS THE BUILD (TS2578,
 * "unused '@ts-expect-error' directive") if the line it guards ever starts compiling. Verified by
 * deliberately making a guarded line valid and watching `tsc -p tsconfig.lib.json` go red.
 *
 * WHY THIS IS NOT A `.spec.ts` FILE. It was, and it proved nothing: tsconfig.lib.json EXCLUDES spec
 * files, and vitest transpiles with esbuild, which strips types without checking them. So a
 * `@ts-expect-error` in a spec is inert — the suite passes whether or not the guarded line really
 * errors. Verified the hard way: with one guarded line deliberately made VALID, both `vitest run` and
 * `nx run core-util:ci` stayed green. A type-level guarantee must be asserted in a file the
 * type-checker actually compiles, which is any non-spec file under `src/`.
 *
 * WHY IT CALLS THE FACTORIES INSTEAD OF USING DECORATOR SYNTAX. A decorator factory is a plain
 * function, so a direct call type-checks the argument identically — and the first cut of this file,
 * which used `@ApiPath` + `@Endpoint` on an abstract class, made the architecture scanner classify
 * core-util as exporting an API contract and demand a `role:api-lib` tag. A test fixture must not
 * change what the repo believes about its own architecture.
 *
 * The counterpart RUNTIME behaviour (that `allRolesAllowed: true` reads back as `[]` through
 * `rolesRequired`) is asserted in `__tests__/pubsub-and-auth-decorators.spec.ts`, where runtime
 * assertions belong.
 */
export class AuthJwtCompileAssertions {
    /** The two legitimate spellings must keep compiling; this half is asserted by the ABSENCE of error. */
    legitimate(): void {
        void WpAuthJwt({ roles: ['admin'] });
        void WpAuthJwt({ roles: ['admin', 'editor'] });
        void WpAuthJwt({ allRolesAllowed: true });
        void WpAuthJwt({ allRolesAllowed: true, inOrg: true });
        void WpAuthJwt({ roles: ['admin'], tenantScoped: true });
    }

    /** Every one of these must be UNWRITABLE. A directive going unused here fails the build. */
    rejected(): void {
        // @ts-expect-error pick a branch — {} may not mean "any authenticated user"
        void WpAuthJwt({});
        // @ts-expect-error roles needs AT LEAST ONE entry; [] was the old silent widest grant
        void WpAuthJwt({ roles: [] });
        // @ts-expect-error contradictory: wide AND role-gated at the same time
        void WpAuthJwt({ allRolesAllowed: true, roles: ['admin'] });
        // @ts-expect-error allRolesAllowed:false is a redundant SECOND spelling of role-gating
        void WpAuthJwt({ roles: ['admin'], allRolesAllowed: false });
        // @ts-expect-error `false` is never how you say "wide" — the other branch is for that
        void WpAuthJwt({ allRolesAllowed: false });
        // @ts-expect-error app-defined fields alone authorize nothing; a role decision is mandatory
        void WpAuthJwt({ inOrg: true });
    }

    /** Class-level auth readers were deleted; every metadata lookup must name the audited method. */
    readersRequireMethodName(): void {
        // @ts-expect-error methodName is mandatory so removed class-level auth cannot silently compile
        void getAuthMeta(AuthJwtCompileAssertions);
        // @ts-expect-error methodName is mandatory so removed class-level auth cannot silently compile
        void getAuthMode(AuthJwtCompileAssertions);
    }
}
