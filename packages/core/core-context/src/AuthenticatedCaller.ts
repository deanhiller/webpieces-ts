import { ContextTuple } from '@webpieces/core-util';

/**
 * AuthenticatedCaller - what an authenticator PROVED about the caller of ONE request. Every hook
 * that authenticates resolves to this: {@link JwtHook.parseJwt}, {@link ApiKeyHook.verifyApiKey} and
 * {@link VendorAuthHook.verify}. Four fields, three jobs:
 *
 *  - `userId`          — WHO the caller is, as the credential proved it.
 *  - `roles` / `claims` — the AUTHORIZATION inputs: `roles` is what the framework's own any-of check
 *                        reads, `claims` carries credential facts for the authenticator to validate and publish
 *                        as trusted application context before AuthorizationHook evaluates policy.
 *  - `entries`         — the TRUSTED CONTEXT to seed. The framework writes each one with
 *                        {@link RequestContext.putTrusted}, so return only what THIS authenticator
 *                        derived from the credential it just verified.
 *
 * NAMING, said out loud so it is not "fixed" back: it is deliberately NOT a `TrustedContextMap`.
 * Three of the four fields are not context, and it is not a Map — it is the authenticated caller,
 * and the context is one thing it carries.
 *
 * Data-only structure (a class, per the guidelines).
 */
export class AuthenticatedCaller {
    constructor(
        public readonly userId: string | undefined,
        public readonly roles: string[] = [],
        public readonly entries: ContextTuple[] = [],
        // webpieces-disable no-any-unknown -- raw JWT claims for app-defined authorization (inOrg, tenant, ...)
        public readonly claims: Record<string, unknown> = {},
        public readonly machine?: AuthenticatedMachineIdentity,
    ) {}
}

/** Verified external machine identity does not grant trusted-header delegation. */
export class AuthenticatedMachineIdentity {
    constructor(public readonly mechanism: string, public readonly identity: string) {}
}
