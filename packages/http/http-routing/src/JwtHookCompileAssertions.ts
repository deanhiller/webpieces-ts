import { JwtRequirement } from '@webpieces/core-util';
import { JwtHook } from './AuthHooks';
import { AuthValues } from './AuthConfig';

/**
 * COMPILE-TIME assertions that {@link JwtHook} is ASYNC on BOTH halves, and that the old SYNC spelling
 * of either one no longer compiles. Each `@ts-expect-error` below FAILS THE BUILD (TS2578, "unused
 * '@ts-expect-error' directive") if the override it guards ever starts compiling again.
 *
 * WHY THIS IS NOT A `.spec.ts` FILE — the same reason as `core-util`'s `AuthJwtCompileAssertions.ts`:
 * tsconfig.lib.json EXCLUDES specs and vitest strips types with esbuild, so a `@ts-expect-error` in a
 * spec is inert and the suite passes either way. A type-level guarantee has to be asserted in a file
 * the type-checker actually compiles.
 *
 * WHY IT MATTERS HERE SPECIFICALLY. This repo ships no backwards-compatibility shims, so making the
 * hook async means every existing implementor's sync override must STOP COMPILING — the compile error
 * IS the migration. A sync `parseJwt` that kept compiling would be silently awaited to the same value
 * and the break would look optional, which is precisely how an old spelling survives. Pinning both
 * directions here means the async-ness cannot be quietly relaxed later either.
 */
export class JwtHookCompileAssertions {
    /** The async spellings must keep compiling; asserted by the ABSENCE of an error. */
    legitimate(): void {
        void class extends JwtHook {
            override async parseJwt(_token: string): Promise<AuthValues> {
                return new AuthValues('u1');
            }

            override async authorizeJwt(_values: AuthValues, _requirement: JwtRequirement): Promise<void> {
                // An implementation that needs no I/O simply has no await — that is allowed and free.
            }
        };
    }

    /** The SYNC spellings — what every implementor wrote before — must now be UNWRITABLE. */
    rejected(): void {
        void class extends JwtHook {
            // @ts-expect-error parseJwt is async now: returning AuthValues instead of Promise<AuthValues> must not compile
            override parseJwt(_token: string): AuthValues {
                return new AuthValues('u1');
            }
        };
        void class extends JwtHook {
            override async parseJwt(_token: string): Promise<AuthValues> {
                return new AuthValues('u1');
            }

            // @ts-expect-error authorizeJwt is async now: a void override must not compile either
            override authorizeJwt(_values: AuthValues, _requirement: JwtRequirement): void {
                // an app rule enforced synchronously — the spelling this change deletes
            }
        };
    }
}
