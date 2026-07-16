import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { LogManager } from '@webpieces/core-util';
import { toError } from '@webpieces/core-util';
import { isOnGcp } from './metadata';
import { getProjectId, getRegion, getRuntimeServiceAccountEmail } from './urls';

const log = LogManager.getLogger('gcp-identity-oidc');

/**
 * Prefix marking a deterministic local (off-GCP) OIDC token. Real Google-signed
 * tokens never start with this, so verify can tell them apart. This is what keeps
 * the @AuthOidc code path fully exercised in tests without any GCP round-trip.
 */
const DEV_TOKEN_PREFIX = 'dev-oidc.';

/** Outcome of verifying an inbound OIDC token against an allow-list of callers. */
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
 * SA, and VERIFY an inbound token against a caller allow-list. Injected by type (@provideSingleton /
 * inject-by-type) into the RPC + Cloud Tasks clients (mint) and the framework auth verifier (verify),
 * so no DI-managed code calls gcp-identity as a free function.
 *
 * Holds the reusable google-auth-library clients as instance state (one per process, since this is a
 * framework singleton) plus the "warned about public posture once" flag.
 */
@provideFrameworkSingleton()
export class GcpOidc {
    private readonly auth = new GoogleAuth();
    private readonly verifier = new OAuth2Client();
    private publicPostureChecked = false;

    /**
     * Mint a Google-signed OIDC ID token for `audience` (the callee's base URL), as this service's
     * runtime SA. Off-GCP returns a self-describing `dev-oidc.*` token that {@link verifyFromCallers}
     * accepts locally.
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
     * Verify an inbound OIDC token and require its caller SA to be in the allow-list. Audience is
     * deliberately NOT gated (mirrors the platform's cross-service model — the callee's own `aud`
     * passes). Never throws — an invalid token or a disallowed caller comes back as `ok:false` so
     * callers map it to a 401 without a try/catch.
     *
     * `callers` entries resolve as: 'self' → this service's runtime SA; a bare id →
     * `<id>@<project>.iam.gserviceaccount.com`; anything containing '@' → verbatim.
     */
    async verifyFromCallers(idToken: string, callers: string[]): Promise<OidcVerifyResult> {
        const email = await this.extractVerifiedEmail(idToken);
        if (!email) {
            return new OidcVerifyResult(false, undefined, 'token invalid or missing email claim');
        }
        // EMPTY allow-list = TRUST THE EDGE: accept any genuine Google-signed OIDC caller, because a
        // PRIVATE Cloud Run service's edge already gated WHO via run.invoker IAM (managed in terraform,
        // one source of truth). Warn loudly (once) if the service is actually PUBLIC — then the edge is
        // NOT filtering callers and this is insecure. Non-empty list = explicit app-level allow-list.
        if (callers.length === 0) {
            await this.warnIfPublicOnce();
            return new OidcVerifyResult(true, email);
        }
        const allowed = await this.resolveCallers(callers);
        if (!allowed.includes(email)) {
            return new OidcVerifyResult(
                false,
                email,
                `caller '${email}' is not in the allow-list [${allowed.join(', ')}]`,
            );
        }
        return new OidcVerifyResult(true, email);
    }

    /**
     * @AuthOidc() (trust-the-edge) is only secure when the Cloud Run service is PRIVATE — the edge
     * enforces run.invoker. If it is actually PUBLIC, warn LOUDLY (once): we still admit only
     * Google-signed callers, but the edge is not filtering WHO. Never fails — this is advisory.
     */
    private async warnIfPublicOnce(): Promise<void> {
        if (this.publicPostureChecked) {
            return;
        }
        this.publicPostureChecked = true; // attempt at most once, even if the check itself errors
        if (!(await isOnGcp())) {
            return; // off-GCP: there is no Cloud Run edge; public/private does not apply.
        }
        if (await this.isServicePublic()) {
            log.error(
                'This endpoint is currently public but marked @AuthOidc which requires the service to be ' +
                    'private. You are currently running in a very insecure mode; however, we are only allowing ' +
                    'google-signed callers in. The edge will validate callers are allowed in (make the Cloud Run ' +
                    'service private — remove the allUsers run.invoker binding) to reduce your attack surface.',
            );
        }
    }

    /**
     * True when THIS Cloud Run service grants run.invoker to allUsers/allAuthenticatedUsers (public).
     * Reads the service's OWN IAM policy via the Run Admin API (needs run.services.getIamPolicy on the
     * runtime SA). On any failure we cannot tell → false (no false alarm).
     */
    private async isServicePublic(): Promise<boolean> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a failed self-IAM read just means "posture unknown" → no warning
        try {
            const [project, region] = await Promise.all([getProjectId(), getRegion()]);
            const service = process.env['K_SERVICE'] ?? '';
            const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}:getIamPolicy`;
            const client = await this.auth.getClient();
            const res = await client.request<IamPolicy>({ url: url });
            return (res.data.bindings ?? []).some(
                (binding: IamBinding) =>
                    binding.role === 'roles/run.invoker' &&
                    (binding.members ?? []).some((m: string) => m === 'allUsers' || m === 'allAuthenticatedUsers'),
            );
        } catch (err: unknown) {
            const error = toError(err);
            log.debug(`Could not read own Cloud Run IAM policy (need run.services.getIamPolicy): ${error.message}`);
            return false;
        }
    }

    private makeDevToken(email: string, audience: string): string {
        const payload = JSON.stringify({ email: email, aud: audience });
        return DEV_TOKEN_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
    }

    private async extractVerifiedEmail(idToken: string): Promise<string | undefined> {
        if (idToken.startsWith(DEV_TOKEN_PREFIX)) {
            return this.decodeDevTokenEmail(idToken);
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a genuinely unverifiable token is unauthenticated (→ undefined → 401); infra failures are re-thrown below
        try {
            const ticket = await this.verifier.verifyIdToken({ idToken: idToken });
            const payload = ticket.getPayload();
            return payload?.email ?? undefined;
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
            return undefined;
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

    private async resolveCallers(callers: string[]): Promise<string[]> {
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

/** Minimal shape of a Cloud Run getIamPolicy response. */
interface IamBinding {
    role: string;
    members?: string[];
}
interface IamPolicy {
    bindings?: IamBinding[];
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
