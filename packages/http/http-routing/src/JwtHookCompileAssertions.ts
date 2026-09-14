import { JwtRequirement } from '@webpieces/core-util';
import { JwtHook, MintedJwt } from './AuthHooks';
import { AuthenticatedCaller } from './AuthConfig';

/**
 * COMPILE-TIME assertions that {@link JwtHook} mint/parse/authorize are async, mint is required, and
 * the old SYNC spelling no longer compiles. Each `@ts-expect-error` below FAILS THE BUILD (TS2578, "unused
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
        class ApplicationMintRequest {
            constructor(public readonly applicationClaim: string) {}
        }
        void class extends JwtHook<ApplicationMintRequest> {
            override async mint(request: ApplicationMintRequest): Promise<MintedJwt> {
                return new MintedJwt(request.applicationClaim, Date.now() / 1000 + 60);
            }

            override async parseJwt(_token: string): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('u1');
            }

            override async authorizeJwt(_values: AuthenticatedCaller, _requirement: JwtRequirement): Promise<void> {
                // An implementation that needs no I/O simply has no await — that is allowed and free.
            }
        };

        class RemoteSigner {
            async sign(request: ApplicationMintRequest): Promise<MintedJwt> {
                return new MintedJwt(request.applicationClaim, Date.now() / 1000 + 60);
            }
        }
        const remoteSigner = new RemoteSigner();
        void class extends JwtHook<ApplicationMintRequest> {
            override mint(request: ApplicationMintRequest): Promise<MintedJwt> {
                return remoteSigner.sign(request);
            }

            override async parseJwt(_token: string): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('remote-u1');
            }
        };
    }

    /** The SYNC spellings — what every implementor wrote before — must now be UNWRITABLE. */
    rejected(): void {
        // @ts-expect-error mint is a required compile-time obligation
        void class extends JwtHook<string> {
            // @ts-expect-error parseJwt is async now: returning AuthenticatedCaller instead of Promise<AuthenticatedCaller> must not compile
            override parseJwt(_token: string): AuthenticatedCaller {
                return new AuthenticatedCaller('u1');
            }
        };
        void class extends JwtHook<string> {
            // @ts-expect-error mint is always async: a synchronous signer returns Promise.resolve through the contract
            override mint(request: string): MintedJwt {
                return new MintedJwt(request, Date.now() / 1000 + 60);
            }

            override async parseJwt(_token: string): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('u1');
            }
        };
        void class extends JwtHook<string> {
            override async mint(request: string): Promise<MintedJwt> {
                return new MintedJwt(request, Date.now() / 1000 + 60);
            }

            override async parseJwt(_token: string): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('u1');
            }

            // @ts-expect-error authorizeJwt is async now: a void override must not compile either
            override authorizeJwt(_values: AuthenticatedCaller, _requirement: JwtRequirement): void {
                // an app rule enforced synchronously — the spelling this change deletes
            }
        };
    }
}
