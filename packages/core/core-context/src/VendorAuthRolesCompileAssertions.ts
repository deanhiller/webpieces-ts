import { AuthenticatedCaller } from './AuthenticatedCaller';
import { RawHttpRequest } from './HttpRequest';
import * as CoreContext from './index';
import { SignableRequest, VendorAuthMinter, VENDOR_AUTH_MINTER } from './VendorAuthMinter';
import { VendorAuthVerifier, VENDOR_AUTH_VERIFIER } from './VendorAuthVerifier';

/** A CLIENT-only process's minter: mint + refresh, and NOTHING meaningless beside them. */
class MinterOnly extends VendorAuthMinter {
    override async mint(_name: string, _request: SignableRequest): Promise<Map<string, string>> {
        return new Map([['Authorization', 'Bearer held-worker-token']]);
    }

    override async refresh(_name: string): Promise<void> {
        // renew from this process's own credential source
    }
}

/** A SERVER-only process's verifier: verify, and NOTHING meaningless beside it. */
class VerifierOnly extends VendorAuthVerifier {
    override async verify(_name: string, request: RawHttpRequest): Promise<AuthenticatedCaller> {
        return new AuthenticatedCaller(`vendor:${request.raw.rawBody.length}`);
    }
}

/**
 * COMPILE-TIME proof of the #1358 role split. `vendorAuth(name)` is served by TWO independent DI
 * roles — the outbound {@link VendorAuthMinter} and the inbound {@link VendorAuthVerifier} — and the
 * unified `VendorAuthHook` / `VENDOR_AUTH_HOOK` they replace is DELETED, not aliased. Each
 * `@ts-expect-error` FAILS THE BUILD (TS2578) the moment the thing it guards starts compiling again.
 *
 * A compiled file, never a `.spec.ts`: tsconfig.lib.json excludes specs and vitest strips types with
 * esbuild, so a `@ts-expect-error` in a spec is inert.
 *
 * Why the split must be a TYPE fact and not a convention: the unified hook forced a client-only
 * process to implement a meaningless `verify` and a server-only one a meaningless `mint`/`refresh`,
 * and — far worse — made every outbound RPC proxy construct the server's inbound verifier, which
 * closed a DI cycle the moment the verifier depended on an ordinary OIDC RPC client.
 */
export class VendorAuthRolesCompileAssertions {
    /** The unified hook is gone: no alias, no `@deprecated`, by policy. */
    unifiedHookIsDeleted(): void {
        // @ts-expect-error VendorAuthHook is DELETED — split into VendorAuthMinter (outbound) + VendorAuthVerifier (inbound)
        void CoreContext.VendorAuthHook;
        // @ts-expect-error VENDOR_AUTH_HOOK is DELETED — bind VENDOR_AUTH_MINTER (client) and/or VENDOR_AUTH_VERIFIER (server)
        void CoreContext.VENDOR_AUTH_HOOK;
    }

    /** Each role is implementable ALONE — asserted by the absence of an error on the classes above. */
    eachRoleStandsAlone(): void {
        const minter: VendorAuthMinter = new MinterOnly();
        const verifier: VendorAuthVerifier = new VerifierOnly();
        void minter;
        void verifier;
    }

    /** A minter-only class does not implement verification, so it cannot fill the inbound role. */
    minterIsNotAVerifier(): void {
        // @ts-expect-error a minter has no verify(): it is not a VendorAuthVerifier
        const verifier: VendorAuthVerifier = new MinterOnly();
        void verifier;
        void class extends VendorAuthMinter {
            override async mint(): Promise<Map<string, string>> {
                return new Map();
            }

            override async refresh(): Promise<void> {
                // renew
            }

            // @ts-expect-error verify is not a member of the outbound role, so it cannot be overridden there
            override async verify(_name: string, _request: RawHttpRequest): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('never');
            }
        };
    }

    /** A verifier-only class does not implement minting or refresh, so it cannot fill the outbound role. */
    verifierIsNotAMinter(): void {
        // @ts-expect-error a verifier has no mint()/refresh(): it is not a VendorAuthMinter
        const minter: VendorAuthMinter = new VerifierOnly();
        void minter;
        void class extends VendorAuthVerifier {
            override async verify(): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('vendor');
            }

            // @ts-expect-error mint is not a member of the inbound role, so it cannot be overridden there
            override async mint(): Promise<Map<string, string>> {
                return new Map();
            }
        };
    }

    /** The two binding identities are distinct unique symbols: one cannot be passed as the other. */
    tokensAreNotInterchangeable(): void {
        // @ts-expect-error the inbound token is not the outbound token
        const outbound: typeof VENDOR_AUTH_MINTER = VENDOR_AUTH_VERIFIER;
        // @ts-expect-error the outbound token is not the inbound token
        const inbound: typeof VENDOR_AUTH_VERIFIER = VENDOR_AUTH_MINTER;
        void outbound;
        void inbound;
    }
}
