import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { LogManager } from '@webpieces/wp-logging';
import { toError } from '@webpieces/core-util';
import { isOnGcp } from './metadata';
import { getProjectId, getRuntimeServiceAccountEmail } from './urls';

const log = LogManager.getLogger('gcp-identity-oidc');

/**
 * Prefix marking a deterministic local (off-GCP) OIDC token. Real Google-signed
 * tokens never start with this, so verify can tell them apart. This is what keeps
 * the @AuthOidc code path fully exercised in tests without any GCP round-trip.
 */
const DEV_TOKEN_PREFIX = 'dev-oidc.';

const reusableAuth = new GoogleAuth();
const reusableVerifier = new OAuth2Client();

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
 * Mint a Google-signed OIDC ID token for `audience` (the callee's base URL), as
 * this service's runtime SA. Off-GCP returns a self-describing `dev-oidc.*` token
 * that verifyOidcFromCallers accepts locally.
 */
export async function mintIdToken(audience: string): Promise<string> {
    if (!(await isOnGcp())) {
        const email = await getRuntimeServiceAccountEmail();
        return makeDevToken(email, audience);
    }
    const client = await reusableAuth.getIdTokenClient(audience);
    return client.idTokenProvider.fetchIdToken(audience);
}

/**
 * Verify an inbound OIDC token and require its caller SA to be in the allow-list.
 * Audience is deliberately NOT gated (mirrors the platform's cross-service model —
 * the callee's own `aud` passes). Never throws — an invalid token or a disallowed
 * caller comes back as `ok:false` so callers map it to a 401 without a try/catch.
 *
 * `callers` entries resolve as: 'self' → this service's runtime SA; a bare id →
 * `<id>@<project>.iam.gserviceaccount.com`; anything containing '@' → verbatim.
 */
export async function verifyOidcFromCallers(
    idToken: string,
    callers: string[],
): Promise<OidcVerifyResult> {
    const email = await extractVerifiedEmail(idToken);
    if (!email) {
        return new OidcVerifyResult(false, undefined, 'token invalid or missing email claim');
    }
    const allowed = await resolveCallers(callers);
    if (!allowed.includes(email)) {
        return new OidcVerifyResult(
            false,
            email,
            `caller '${email}' is not in the allow-list [${allowed.join(', ')}]`,
        );
    }
    return new OidcVerifyResult(true, email);
}

function makeDevToken(email: string, audience: string): string {
    const payload = JSON.stringify({ email: email, aud: audience });
    return DEV_TOKEN_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

async function extractVerifiedEmail(idToken: string): Promise<string | undefined> {
    if (idToken.startsWith(DEV_TOKEN_PREFIX)) {
        return decodeDevTokenEmail(idToken);
    }
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an unverifiable token is simply unauthenticated → undefined → 401 upstream
    try {
        const ticket = await reusableVerifier.verifyIdToken({ idToken: idToken });
        const payload = ticket.getPayload();
        return payload?.email ?? undefined;
    } catch (err: unknown) {
        const error = toError(err);
        log.debug(`OIDC token verify failed: ${error.message}`);
        return undefined;
    }
}

function decodeDevTokenEmail(idToken: string): string | undefined {
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

async function resolveCallers(callers: string[]): Promise<string[]> {
    return Promise.all(callers.map((caller: string) => resolveCaller(caller)));
}

async function resolveCaller(caller: string): Promise<string> {
    if (caller === 'self') {
        return getRuntimeServiceAccountEmail();
    }
    if (caller.includes('@')) {
        return caller;
    }
    const projectId = await getProjectId();
    return `${caller}@${projectId}.iam.gserviceaccount.com`;
}

/** Shape of the decoded dev-oidc token payload. */
class DevTokenPayload {
    email!: string;
    aud!: string;
}
