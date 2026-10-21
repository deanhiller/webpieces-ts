import { HttpRequest, RawHttpRequest, RawRequest } from '@webpieces/core-context';
// @ts-expect-error HeaderReader is DELETED — an ApiKeyHook now receives the whole HttpRequest, so it
// reaches getHeaderValues and the ContextKey overload of getHeader that the narrow reader hid.
import type { HeaderReader } from './AuthHooks';
// @ts-expect-error AuthValues is RENAMED to AuthenticatedCaller — there is no alias, by policy.
import type { AuthValues } from './AuthConfig';
import { OidcAuthMethod, OidcAuthMethods } from '@webpieces/core-util';
import { VendorAuthHook } from '@webpieces/core-context';
// @ts-expect-error WebhookAuthCallback is REPLACED by VendorAuthHook (mint/refresh/verify) — no alias, by policy.
import type { WebhookAuthCallback } from './AuthHooks';
// @ts-expect-error WEBHOOK_AUTH_CALLBACK is REPLACED by VENDOR_AUTH_HOOK.
import { WEBHOOK_AUTH_CALLBACK } from './AuthHooks';
import { ApiKeyHook, OidcHook } from './AuthHooks';
import { AuthenticatedCaller, AuthenticatedMachineIdentity } from './AuthConfig';

/**
 * COMPILE-TIME assertions that the four auth hooks share ONE shape, and that every spelling this
 * change deleted has actually stopped compiling. Each `@ts-expect-error` FAILS THE BUILD (TS2578,
 * "unused '@ts-expect-error' directive") the moment the thing it guards starts compiling again.
 *
 * WHY THIS IS NOT A `.spec.ts` FILE — the same reason as {@link JwtHookCompileAssertions}:
 * tsconfig.lib.json EXCLUDES specs and vitest strips types with esbuild, so a `@ts-expect-error` in a
 * spec is inert and the suite passes either way. A type-level guarantee has to be asserted in a file
 * the type-checker actually compiles.
 *
 * WHY IT MATTERS HERE. This repo ships no backwards-compatibility shims: the compile error IS the
 * migration. An implementor that kept `verify(name, request, raw)` or a `HeaderReader` parameter
 * would otherwise sit there compiling, and an accepted shape is never migrated.
 */
export class AuthHooksCompileAssertions {
    /**
     * The DELETED type names, kept referenced so the two `@ts-expect-error`s above are load-bearing
     * rather than decorative. Both resolve to `any` under the suppressed error; the assertion is the
     * IMPORT failing, not what these aliases denote.
     */
    // webpieces-disable no-any-unknown -- a suppressed import of a deleted symbol resolves to any; the assertion is the import error itself
    deletedNames(): void {
        const headerReaderIsGone: HeaderReader | undefined = undefined;
        const authValuesIsGone: AuthValues | undefined = undefined;
        const webhookAuthCallbackIsGone: WebhookAuthCallback | undefined = undefined;
        void headerReaderIsGone;
        void authValuesIsGone;
        void webhookAuthCallbackIsGone;
        void WEBHOOK_AUTH_CALLBACK;
    }

    /** The ALIGNED spellings must keep compiling; asserted by the ABSENCE of an error. */
    legitimate(): void {
        void class extends VendorAuthHook {
            override async mint(): Promise<Map<string, string>> {
                return new Map([['Authorization', 'Bearer t']]);
            }

            override async refresh(): Promise<void> {
                // renew the vendor credential
            }

            override async verify(_name: string, request: RawHttpRequest): Promise<AuthenticatedCaller> {
                // No `raw!`, no `if (!raw) throw`: AuthFilter checked once and the TYPE carries it.
                const bytes: Buffer = request.raw.rawBody;
                return new AuthenticatedCaller(`sentry:${bytes.length}`);
            }
        };
        void class extends ApiKeyHook {
            override async verifyApiKey(_name: string, request: HttpRequest): Promise<AuthenticatedCaller> {
                // Both of these were UNREACHABLE through the deleted one-method HeaderReader.
                const all: string[] | undefined = request.getHeaderValues('x-api-key');
                return new AuthenticatedCaller(all?.[0] ?? 'anonymous');
            }
        };
    }

    /** Every spelling this change deleted must now be UNWRITABLE. */
    rejected(): void {
        void class extends VendorAuthHook {
            override async mint(): Promise<Map<string, string>> {
                return new Map();
            }

            override async refresh(): Promise<void> {
                // renew the vendor credential
            }

            // @ts-expect-error verify takes (name, RawHttpRequest): the three-parameter spelling is gone
            override async verify(_name: string, _request: HttpRequest, _raw: RawRequest): Promise<AuthenticatedCaller> {
                return new AuthenticatedCaller('u1');
            }
        };
        void class extends VendorAuthHook {
            override async mint(): Promise<Map<string, string>> {
                return new Map();
            }

            override async refresh(): Promise<void> {
                // renew the vendor credential
            }

            // @ts-expect-error verify returns the caller it proved: a void override must not compile
            override async verify(_name: string, _request: RawHttpRequest): Promise<void> {
                // a hook that verifies and then has no way to say what it proved
            }
        };
    }

    /**
     * {@link OidcHook.verifyOidc} receives EVERY OIDC method the endpoint declares ({@link OidcAuthMethods}),
     * so a hook verifies the token once and can tell `oidcSameProject()` from `oidcSvcs([...])`. The
     * caller-list override this change deletes (`callers: string[]`, where an EMPTY list meant "any
     * Google-signed caller") and a one-method override, which could not see the other scope of a pair,
     * must not compile.
     */
    oidcHookTakesTheMethods(): void {
        void class extends OidcHook {
            override async verifyOidc(_token: string, methods: OidcAuthMethods): Promise<AuthenticatedMachineIdentity> {
                const first = methods[0];
                const named = first.callerScope === 'services' ? first.callers[0] : 'same-project';
                return new AuthenticatedMachineIdentity('oidc', named);
            }
        };
        void class extends OidcHook {
            // @ts-expect-error verifyOidc takes the endpoint's OidcAuthMethods; the deleted caller-list override must not compile
            override async verifyOidc(_token: string, _callers: string[]): Promise<AuthenticatedMachineIdentity> {
                return new AuthenticatedMachineIdentity('oidc', 'caller@example.test');
            }
        };
        void class extends OidcHook {
            // @ts-expect-error verifyOidc takes every OIDC method of the endpoint, not one, so a pair is verified once
            override async verifyOidc(_token: string, _method: OidcAuthMethod): Promise<AuthenticatedMachineIdentity> {
                return new AuthenticatedMachineIdentity('oidc', 'caller@example.test');
            }
        };
    }

    /**
     * An {@link HttpRequest} whose `raw` is merely OPTIONAL is NOT a {@link RawHttpRequest}. This is
     * the assignment that makes the narrowing real: without it, `RawHttpRequest` would be a comment.
     */
    rawIsNotOptional(): void {
        const maybeRaw = new HttpRequest('POST', '/hook/sentry/issue', new Map<string, string[]>());
        // @ts-expect-error HttpRequest.raw is optional, so it is not assignable to RawHttpRequest
        const narrowed: RawHttpRequest = maybeRaw;
        void narrowed;

        // The other direction is free: a RawHttpRequest IS an HttpRequest everywhere one is wanted.
        const proven = new HttpRequest(
            'POST',
            '/hook/sentry/issue',
            new Map<string, string[]>(),
            new RawRequest('https://example.com/hook', Buffer.from('{}', 'utf8'), '1.2.3.4'),
        ) as RawHttpRequest;
        const widened: HttpRequest = proven;
        void widened;
    }
}
