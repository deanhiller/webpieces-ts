import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { LogManager, OidcAuthMethod, OidcAuthMethods, OidcCallers } from '@webpieces/core-util';
import { toError } from '@webpieces/core-util';
import { isOnGcp, readNumericProjectId, readProjectId } from './metadata';
import { getProjectId, getRuntimeServiceAccountEmail } from './urls';

const log = LogManager.getLogger('gcp-identity-oidc');

/**
 * Prefix marking a deterministic local (off-GCP) OIDC token. Real Google-signed
 * tokens never start with this, so verify can tell them apart. This is what keeps
 * the OIDC (`oidcSameProject()` / `oidcSvcs(...)`) code path fully exercised in tests
 * without any GCP round-trip.
 * The token is UNSIGNED, so verify accepts it only where mint creates it: off GCP.
 */
const DEV_TOKEN_PREFIX = 'dev-oidc.';

/** Why a token proved no caller email, in every case but the one below. */
const NO_VERIFIED_EMAIL = 'token invalid or missing email claim';

/**
 * Why a dev token is refused on GCP. The caller does not see it: DefaultOidcVerifier throws it inside an
 * ApiUnauthorizedError, and ApiErrorBoundary / ApiErrorCodec.publicMessage disclose only an
 * ApiEndUserError's own message, so the caller gets the generic 401 text. The operator sees it twice:
 * in the thrown error's message, which LogApiCall records on the server's resp-FAIL line, and in the
 * warn line below. It names the rule and the cure, never the token or the email it claims.
 */
const DEV_TOKEN_ON_GCP =
    'dev-oidc token refused on GCP: dev tokens are unsigned and accepted only off GCP, where ' +
    'mintIdToken creates them; send a Google-signed ID token';

/** Outcome of verifying an inbound OIDC token against an endpoint's caller scope. */
export class OidcVerifyResult {
    /** True when the token is valid AND its caller SA is allowed. */
    ok: boolean;
    /** The verified caller email (present when ok). */
    email?: string;
    /** Human-readable reason when not ok (for logs / 401 message). */
    reason?: string;

    constructor(ok: boolean, email?: string, reason?: string) {
        this.ok = ok;
        this.email = email;
        this.reason = reason;
    }
}

/**
 * GcpOidc - Google OIDC service-to-service tokens: MINT an outbound token as this service's runtime
 * SA, and VERIFY an inbound token against the OIDC methods its endpoint declares
 * (`oidcSameProject()` and/or `oidcSvcs([...])`, see {@link verify}). Injected by type
 * (@provideSingleton / inject-by-type) into the RPC + Cloud Tasks clients (mint) and the framework
 * auth verifier (verify), so no DI-managed code calls gcp-identity as a free function.
 *
 * Verify has one rule for the unsigned `dev-oidc.*` token: it is accepted only OFF GCP, where
 * {@link mintIdToken} creates it. On GCP it is refused before any caller check.
 *
 * Holds the reusable google-auth-library clients as instance state (one per process, since this is a
 * framework singleton).
 */
@provideFrameworkSingleton()
export class GcpOidc {
    private readonly auth = new GoogleAuth();
    private readonly verifier = new OAuth2Client();

    /**
     * Mint a Google-signed OIDC ID token for `audience` (the callee's base URL), as this service's
     * runtime SA. Off-GCP returns a self-describing, unsigned `dev-oidc.*` token instead, and
     * {@link verify} accepts one under the same condition: off GCP only. On GCP it refuses a dev
     * token, so mint and verify agree on where a dev token is legitimate.
     */
    async mintIdToken(audience: string): Promise<string> {
        if (!(await isOnGcp())) {
            const email = await getRuntimeServiceAccountEmail();
            return this.makeDevToken(email, audience);
        }
        const client = await this.auth.getIdTokenClient(audience);
        return client.idTokenProvider.fetchIdToken(audience);
    }

    /**
     * Verify an inbound OIDC token against the endpoint's OIDC methods: the signature is checked ONCE,
     * and the call is admitted when ANY method admits the caller's email. Never throws for a bad token
     * or a disallowed caller, so callers map `ok:false` to a 401 without a try/catch. Audience is
     * deliberately NOT gated (mirrors the platform's cross-service model: the callee's own `aud` passes).
     *
     * - `oidcSameProject()`: the caller must be a service account of THIS GCP project, either
     *   user-managed (`<name>@<projectId>.iam.gserviceaccount.com`) or the project's Compute Engine
     *   default (`<projectNumber>-compute@developer.gserviceaccount.com`). Google service agents
     *   (`service-<number>@gcp-sa-*.iam.gserviceaccount.com` and the other Google-owned domains) are
     *   NOT this project's accounts and are refused, as is a user account. Off GCP there is no project
     *   to compare against, so this check is OPEN.
     * - `oidcSvcs([...])`: the caller must be one of `callers`, which may belong to other projects.
     *   Entries resolve as: 'self' → this service's runtime SA; a bare id →
     *   `<id>@<project>.iam.gserviceaccount.com`; anything containing '@' → verbatim.
     */
    async verify(idToken: string, methods: OidcAuthMethods): Promise<OidcVerifyResult> {
        const verified = await this.extractVerifiedEmail(idToken);
        const email = verified.email;
        if (!email) {
            return new OidcVerifyResult(false, undefined, verified.reasonIfNone);
        }
        const refusals: string[] = [];
        for (const method of methods) {
            const refusal = await this.refusalOf(email, method);
            if (refusal === undefined) {
                return new OidcVerifyResult(true, email);
            }
            refusals.push(refusal);
        }
        return new OidcVerifyResult(false, email, refusals.join('; '));
    }

    /**
     * Why `method` does not admit `email`, or undefined when it does. One branch per scope, then a
     * `never` tail: a scope added to OidcAuthMethod without a branch here stops compiling, and a scope
     * that reaches this method around the type (a cast, plain JS) is refused instead of falling through
     * to admitted. That refusal names the scope only, never the token or the email.
     */
    private async refusalOf(email: string, method: OidcAuthMethod): Promise<string | undefined> {
        switch (method.callerScope) {
            case 'same-project':
                return (await this.admitsSameProject(email))
                    ? undefined
                    : `caller '${email}' is not a service account of this GCP project`;
            case 'services':
                return this.listedRefusal(email, method.callers);
            default: {
                const unhandled: never = method;
                return `unknown OIDC callerScope '${String((unhandled as OidcAuthMethod).callerScope)}'`;
            }
        }
    }

    /** Off GCP there is no project to compare against, so the same-project check is open there. */
    private async admitsSameProject(email: string): Promise<boolean> {
        if (!(await isOnGcp())) {
            return true;
        }
        return this.isThisProjectsServiceAccount(email);
    }

    private async listedRefusal(email: string, callers: OidcCallers): Promise<string | undefined> {
        const allowed = await this.resolveCallers(callers);
        return allowed.includes(email)
            ? undefined
            : `caller '${email}' is not in the allow-list [${allowed.join(', ')}]`;
    }

    /**
     * True when `email` is a service account OF this project. Only two shapes qualify: a user-managed
     * account under `<projectId>.iam.gserviceaccount.com`, and this project number's Compute Engine
     * default account. Matching the WHOLE domain (not a prefix or suffix of it) is what keeps service
     * agents out: they live under Google-owned domains such as `gcp-sa-pubsub.iam.gserviceaccount.com`
     * even when their name carries this project's number. Only called on GCP.
     */
    private async isThisProjectsServiceAccount(email: string): Promise<boolean> {
        const projectId = await readProjectId();
        const projectNumber = await readNumericProjectId();
        const at = email.lastIndexOf('@');
        if (at <= 0) {
            return false;
        }
        return (
            email.substring(at + 1) === `${projectId}.iam.gserviceaccount.com` ||
            email === `${projectNumber}-compute@developer.gserviceaccount.com`
        );
    }

    private makeDevToken(email: string, audience: string): string {
        const payload = JSON.stringify({ email: email, aud: audience });
        return DEV_TOKEN_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
    }

    private async extractVerifiedEmail(idToken: string): Promise<VerifiedEmail> {
        if (idToken.startsWith(DEV_TOKEN_PREFIX)) {
            if (await isOnGcp()) {
                // Mint creates a dev token only OFF GCP, so verify accepts one only there. On GCP it is
                // just unsigned text, so refuse it BEFORE decoding, whatever email it claims.
                log.warn(
                    'Refusing a dev-oidc token, because isOnGcp() is true (K_SERVICE is set, or ' +
                        'METADATA_SERVER_DETECTION=assume-present): ' +
                        DEV_TOKEN_ON_GCP,
                );
                return new VerifiedEmail(undefined, DEV_TOKEN_ON_GCP);
            }
            return new VerifiedEmail(this.decodeDevTokenEmail(idToken), NO_VERIFIED_EMAIL);
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a genuinely unverifiable token is unauthenticated (→ undefined → 401); infra failures are re-thrown below
        try {
            const ticket = await this.verifier.verifyIdToken({ idToken: idToken });
            const payload = ticket.getPayload();
            return new VerifiedEmail(payload?.email ?? undefined, NO_VERIFIED_EMAIL);
        } catch (err: unknown) {
            const error = toError(err);
            if (this.isInfrastructureError(error)) {
                // A network/system failure fetching Google's certs (or a bug) is NOT an auth failure.
                // Do NOT mask it as a 401 — re-throw so it surfaces as a 5xx (alertable / retryable)
                // instead of looking like a caller sent a bad token.
                throw error;
            }
            // Bad signature / expired / malformed token → genuinely unauthenticated → 401 upstream.
            log.debug(`OIDC token rejected (unauthenticated): ${error.message}`);
            return new VerifiedEmail(undefined, NO_VERIFIED_EMAIL);
        }
    }

    /**
     * True when an error thrown while verifying a token is INFRASTRUCTURE (network/system), not a bad
     * token — e.g. the metadata/cert fetch failed. These must NOT be swallowed as a 401 (that would
     * both mislead the caller and hide real outages/bugs behind a client-error status).
     */
    private isInfrastructureError(error: Error): boolean {
        const code = (error as ErrorWithCode).code;
        const networkCodes = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN'];
        return (
            (code !== undefined && networkCodes.includes(code)) ||
            error.name === 'GaxiosError' ||
            error.name === 'FetchError'
        );
    }

    private decodeDevTokenEmail(idToken: string): string | undefined {
        const encoded = idToken.substring(DEV_TOKEN_PREFIX.length);
        const json = Buffer.from(encoded, 'base64url').toString('utf8');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a malformed dev token is just unauthenticated → undefined
        try {
            const parsed = JSON.parse(json) as DevTokenPayload;
            return parsed.email ?? undefined;
        } catch (err: unknown) {
            const error = toError(err);
            log.debug(`dev-oidc token decode failed: ${error.message}`);
            return undefined;
        }
    }

    private async resolveCallers(callers: readonly string[]): Promise<string[]> {
        return Promise.all(callers.map((caller: string) => this.resolveCaller(caller)));
    }

    private async resolveCaller(caller: string): Promise<string> {
        if (caller === 'self') {
            return getRuntimeServiceAccountEmail();
        }
        if (caller.includes('@')) {
            return caller;
        }
        const projectId = await getProjectId();
        return `${caller}@${projectId}.iam.gserviceaccount.com`;
    }
}

/** The caller email a token proved, or `undefined` and the reason it proved none. */
class VerifiedEmail {
    constructor(
        readonly email: string | undefined,
        readonly reasonIfNone: string,
    ) {}
}

/** Shape of the decoded dev-oidc token payload. */
class DevTokenPayload {
    email!: string;
    aud!: string;
}

/** A thrown error carrying an optional Node/system error code (e.g. 'ETIMEDOUT'). */
interface ErrorWithCode {
    code?: string;
}
