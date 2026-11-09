import { HttpRequest, RequestContext } from '@webpieces/core-context';
import {
    ApiImplementationError,
    ApiKeyCredential,
    ApiUnauthorizedError,
    AuthMeta,
    AuthMethod,
    DtoValue,
    LogManager,
    OidcAuthMethod,
    OidcAuthMethods,
    toError,
} from '@webpieces/core-util';
import {
    AuthenticatedCallerContext,
    CredentialVerifiers,
    VERIFIED_MACHINE_CALLER,
    VerifiedMachineCaller,
} from '@webpieces/http-routing';
import {
    MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
    McpHttpAuth,
    VerifiedMcpCredential,
    DEV_OIDC_TOKEN_PREFIX,
    GOOGLE_OIDC_ISSUERS,
    McpOAuthMode,
} from './McpAuth';

const log = LogManager.getLogger('McpDoorAuth');
const BEARER_SCHEME = 'Bearer ';
const SHARED_SECRET_SCHEME = 'Webpieces ';

/**
 * JwtPeek: base64url-decode a JWT's PAYLOAD only. NEVER trusted — the result is used solely to pick
 * which ONE verifier sees the request, and that verifier fully verifies, so a token that merely
 * claims an issuer fails its verification and is a 401. It never falls through to another mode.
 */
export class JwtPeek {
    /** The unverified payload claims, or `undefined` when `token` is not a well-formed JWT. */
    // webpieces-disable no-function-outside-class -- pure decoder used by classification only
    static payloadOf(token: string): Record<string, DtoValue> | undefined {
        const parts = token.split('.');
        if (parts.length !== 3 || parts.some((part: string) => part === '')) return undefined;
        const header = JwtPeek.decodeRecord(parts[0]);
        return header === undefined ? undefined : JwtPeek.decodeRecord(parts[1]);
    }

    /** The unverified `iss` claim, or `undefined`. */
    // webpieces-disable no-function-outside-class -- pure decoder used by classification only
    static issuerOf(token: string): string | undefined {
        const iss = JwtPeek.payloadOf(token)?.['iss'];
        return typeof iss === 'string' ? iss : undefined;
    }

    // webpieces-disable no-function-outside-class -- pure decoder used by classification only
    private static decodeRecord(segment: string): Record<string, DtoValue> | undefined {
        const text = Buffer.from(segment, 'base64url').toString('utf8');
        if (!text.startsWith('{')) return undefined;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a malformed segment is simply "not a JWT" for classification; the chosen verifier decides the rest
        try {
            const value = JSON.parse(text) as DtoValue;
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                ? (value as Record<string, DtoValue>)
                : undefined;
        } catch (err: unknown) {
            const error = toError(err);
            log.debug('Bearer segment is not JSON; classifying it as not a JWT', error);
            return undefined;
        }
    }
}

/** The inbound facts one door mode classifies and verifies: the transport-neutral request. */
export class McpDoorRequest {
    constructor(public readonly http: HttpRequest) {}

    header(name: string): string | undefined {
        return this.http.getHeader(name.toLowerCase());
    }

    /** The `Authorization: Bearer <token>` value, or `undefined`. */
    bearer(): string | undefined {
        const value = this.header('authorization');
        if (!value || !value.startsWith(BEARER_SCHEME)) return undefined;
        const token = value.substring(BEARER_SCHEME.length);
        return token === '' || /\s/.test(token) ? undefined : token;
    }

    /** The `Authorization: Webpieces <secret>` value, or `undefined`. */
    sharedSecret(): string | undefined {
        const value = this.header('authorization');
        if (!value || !value.startsWith(SHARED_SECRET_SCHEME)) return undefined;
        return value.substring(SHARED_SECRET_SCHEME.length);
    }
}

/**
 * What a successful authentication established. The caller itself is already PUBLISHED into
 * `RequestContext` by the mode; these are the facts the door needs afterwards.
 */
export class McpDoorPass {
    constructor(
        /** Which mode authenticated, e.g. `jwt()`, `mcpOAuth(...)`. */
        public readonly mode: string,
        /** True for an internal hop (OIDC, shared secret) whose forwarded trusted context is believed. */
        public readonly callerVerified: boolean,
        /** The raw credential, for the SDK's `AuthInfo.token`. Never forwarded downstream. */
        public readonly token: string,
        /** The verified subject (user id or machine identity). */
        public readonly subject: string,
        public readonly scopes: readonly string[],
        public readonly expiresAtEpochSeconds?: number,
    ) {}
}

/** What a door mode needs to say about a request BEFORE any verification. */
interface McpDoorMode {
    readonly name: string;
    /** Claims some `Authorization: Bearer` credentials, so it can overlap another bearer mode. */
    readonly bearerFamily: boolean;
    /** Pure, cheap, NO crypto, NO I/O: does this request carry MY kind of credential? */
    claims(req: McpDoorRequest): boolean;
    /** Full verification; throws `ApiUnauthorizedError` on reject. Publishes the trusted caller. */
    authenticate(req: McpDoorRequest): Promise<McpDoorPass>;
}

/** `oidcSameProject()` / `oidcSvcs([...])` — ONE bearer credential, verified once against both. */
class OidcDoorMode implements McpDoorMode {
    readonly name: string;
    readonly bearerFamily = true;

    constructor(
        private readonly methods: OidcAuthMethods,
        private readonly verifiers: CredentialVerifiers,
    ) {
        this.name = methods
            .map((method: OidcAuthMethod) =>
                method.callerScope === 'same-project' ? 'oidcSameProject()' : 'oidcSvcs([...])',
            )
            .join(' + ');
    }

    claims(req: McpDoorRequest): boolean {
        const token = req.bearer();
        if (token === undefined) return false;
        if (token.startsWith(DEV_OIDC_TOKEN_PREFIX)) return true;
        const issuer = JwtPeek.issuerOf(token);
        return issuer !== undefined && GOOGLE_OIDC_ISSUERS.includes(issuer);
    }

    async authenticate(req: McpDoorRequest): Promise<McpDoorPass> {
        const token = req.bearer()!;
        const identity = await this.verifiers.verifyOidc(token, this.methods);
        RequestContext.putTrusted(
            VERIFIED_MACHINE_CALLER,
            new VerifiedMachineCaller(identity.mechanism, identity.identity),
        );
        return new McpDoorPass(this.name, true, token, identity.identity, []);
    }
}

/** `sharedSecret(key)` — the `Authorization: Webpieces <secret>` scheme, disjoint from every bearer. */
class SharedSecretDoorMode implements McpDoorMode {
    readonly name: string;
    readonly bearerFamily = false;

    constructor(
        private readonly secretKey: string,
        private readonly verifiers: CredentialVerifiers,
    ) {
        this.name = `sharedSecret('${secretKey}')`;
    }

    claims(req: McpDoorRequest): boolean {
        return req.sharedSecret() !== undefined;
    }

    async authenticate(req: McpDoorRequest): Promise<McpDoorPass> {
        const secret = req.sharedSecret()!;
        this.verifiers.verifySharedSecret(secret, this.secretKey);
        RequestContext.putTrusted(
            VERIFIED_MACHINE_CALLER,
            new VerifiedMachineCaller('shared-secret', this.secretKey),
        );
        return new McpDoorPass(this.name, true, secret, `shared-secret:${this.secretKey}`, []);
    }
}

/**
 * `apiKey(regime, credentials)` — claimed by its OWN declared headers. A bearer credential in the
 * regime also claims `Authorization: Bearer`, which is why startup refuses it beside any other bearer
 * mode.
 */
class ApiKeyDoorMode implements McpDoorMode {
    readonly name: string;
    readonly bearerFamily: boolean;
    private readonly headers: readonly string[];
    private readonly callerContext = new AuthenticatedCallerContext();

    constructor(
        private readonly regime: string,
        credentials: readonly ApiKeyCredential[],
        private readonly verifiers: CredentialVerifiers,
    ) {
        this.name = `apiKey('${regime}', ...)`;
        const headers: string[] = [];
        let bearer = false;
        for (const credential of credentials) {
            if (credential.in === 'bearer') {
                bearer = true;
                continue;
            }
            const header = (credential.key.httpHeader ?? '').toLowerCase();
            if (header === 'authorization') {
                throw new Error(
                    `${this.name} declares its header credential on 'authorization', which every other ` +
                        "mode's credential rides; declare it { in: 'bearer' } or on its own header.",
                );
            }
            headers.push(header);
        }
        this.headers = headers;
        this.bearerFamily = bearer;
    }

    claims(req: McpDoorRequest): boolean {
        if (this.headers.some((header: string) => req.header(header) !== undefined)) return true;
        return this.bearerFamily && req.bearer() !== undefined;
    }

    async authenticate(req: McpDoorRequest): Promise<McpDoorPass> {
        const caller = await this.verifiers.verifyApiKey(this.regime, req.http);
        this.callerContext.publish(caller);
        return new McpDoorPass(
            this.name,
            false,
            '',
            caller.userId ?? caller.machine?.identity ?? this.regime,
            [],
        );
    }
}

/**
 * `jwt()` — the app's own user token. It claims the REMAINDER of the bearer space: every
 * `Authorization: Bearer` credential that no other configured bearer mode claims. That makes it
 * disjoint from them by construction, with no issuer to configure.
 */
class JwtDoorMode implements McpDoorMode {
    readonly name = 'jwt()';
    readonly bearerFamily = true;
    private readonly callerContext = new AuthenticatedCallerContext();
    private others: readonly McpDoorMode[] = [];

    constructor(private readonly verifiers: CredentialVerifiers) {}

    excluding(others: readonly McpDoorMode[]): void {
        this.others = others.filter((mode: McpDoorMode) => mode !== this && mode.bearerFamily);
    }

    claims(req: McpDoorRequest): boolean {
        return (
            req.bearer() !== undefined && !this.others.some((mode: McpDoorMode) => mode.claims(req))
        );
    }

    async authenticate(req: McpDoorRequest): Promise<McpDoorPass> {
        const token = req.bearer()!;
        const caller = await this.verifiers.verifyJwt(token);
        this.callerContext.publish(caller);
        return new McpDoorPass(
            this.name,
            false,
            token,
            caller.userId ?? caller.machine?.identity ?? 'jwt',
            [],
        );
    }
}

/** `mcpOAuth(...)` — an audience-bound access token minted by the application's authority. */
export class McpOAuthDoorMode implements McpDoorMode {
    readonly name = 'mcpOAuth(...)';
    readonly bearerFamily = true;
    private readonly callerContext = new AuthenticatedCallerContext();

    constructor(
        public readonly mode: McpOAuthMode,
        private readonly resource: string,
    ) {}

    claims(req: McpDoorRequest): boolean {
        const token = req.bearer();
        if (token === undefined) return false;
        const format = this.mode.tokenFormat;
        switch (format.kind) {
            case 'every-bearer':
                return true;
            case 'opaque-prefix':
                return token.startsWith(format.prefix);
            case 'jwt-issuer': {
                const issuer = JwtPeek.issuerOf(token);
                return issuer !== undefined && this.mode.authorizationServers.includes(issuer);
            }
        }
    }

    async authenticate(req: McpDoorRequest): Promise<McpDoorPass> {
        const token = req.bearer()!;
        const credential = await this.mode.authority.verifyAccessToken(token, this.resource);
        this.validateCredential(credential);
        this.callerContext.publish(credential.caller);
        return new McpDoorPass(
            this.name,
            false,
            token,
            credential.subject,
            credential.scopes,
            credential.expiresAtEpochSeconds,
        );
    }

    private validateCredential(credential: VerifiedMcpCredential): void {
        const now = Math.floor(Date.now() / 1000);
        const reject = (reason: string): never => {
            throw new ApiUnauthorizedError(`MCP access token rejected: ${reason}`);
        };
        if (credential.subject.trim() === '') reject('no subject');
        const stamps = [
            credential.issuedAtEpochSeconds,
            credential.expiresAtEpochSeconds,
            credential.accountValidatedAtEpochSeconds,
        ];
        if (!stamps.every(Number.isFinite)) reject('security timestamps must be finite');
        if (credential.resource !== this.resource) reject('resource mismatch');
        if (!this.mode.authorizationServers.includes(credential.issuer)) {
            reject('issuer is not trusted');
        }
        if (credential.issuedAtEpochSeconds > now || credential.expiresAtEpochSeconds <= now) {
            reject('outside its valid time window');
        }
        const lifetime = credential.expiresAtEpochSeconds - credential.issuedAtEpochSeconds;
        if (lifetime > MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS) reject('lifetime exceeds 30 days');
        for (const scope of this.mode.requiredScopes) {
            if (!credential.scopes.includes(scope)) reject(`missing required scope '${scope}'`);
        }
        const validatedAge = now - credential.accountValidatedAtEpochSeconds;
        if (
            credential.accountValidatedAtEpochSeconds > now ||
            validatedAge > this.mode.maxAccountValidationAgeSeconds
        ) {
            reject('account authorization state is not fresh enough for dispatch');
        }
    }
}

/**
 * CLASSIFY, then verify with exactly ONE verifier.
 *
 * Credentials are self-describing, so one path serves every mode. The request is classified from
 * UNVERIFIED surface facts — which header; a JWT's unverified `iss` — then handed to exactly ONE mode.
 * Classifying on unverified data is safe because the chosen verifier fully verifies: a token that
 * merely claims `iss: accounts.google.com` fails Google's verification and the request is a 401. It
 * never falls through to another mode.
 *
 * - No claimant: only an `mcpOAuth(...)` server answers with the discovery challenge; others a plain 401.
 * - Two claimants (an api-key header AND a bearer): ambiguous, refused — never "pick the one that works".
 * - One claimant: its rejection IS the answer.
 *
 * The set is checked at construction (bind time): `vendorAuth` / public are refused, every mode's
 * verifier must be bound, and no two modes may be able to claim one request.
 */
export class McpDoorAuthenticator {
    private constructor(
        private readonly modes: readonly McpDoorMode[],
        public readonly oauth: McpOAuthDoorMode | undefined,
    ) {}

    // webpieces-disable no-function-outside-class -- validating factory; the constructor stays private so an unchecked set cannot exist
    static create(
        auth: readonly McpHttpAuth[],
        resource: string,
        verifiers: CredentialVerifiers | undefined,
    ): McpDoorAuthenticator {
        const oauthModes = auth.filter(
            (mode: McpHttpAuth): mode is McpOAuthMode => mode instanceof McpOAuthMode,
        );
        if (oauthModes.length > 1) {
            throw new Error(
                'WpMcpServerConfig.setAuth([...]) accepts at most one mcpOAuth(...) mode.',
            );
        }
        McpDoorAuthenticator.refuseNonCallers(auth);
        const methods = auth.filter(
            (mode: McpHttpAuth): mode is AuthMethod => !(mode instanceof McpOAuthMode),
        );
        if (methods.length > 0) {
            // The same declaration rules @WpAuth applies: no duplicate kinds (one oidc per scope), valid shapes.
            new AuthMeta([methods[0], ...methods.slice(1)], undefined);
        }
        const modes: McpDoorMode[] = [];
        const oauth =
            oauthModes[0] === undefined ? undefined : new McpOAuthDoorMode(oauthModes[0], resource);
        if (methods.length > 0) {
            if (!verifiers) {
                throw new Error(
                    'WpMcpServerConfig.setAuth([...]) holds @WpAuth modes; add setCredentialVerifiers(router.credentialVerifiers()).',
                );
            }
            McpDoorAuthenticator.refuseUnverifiable(methods, verifiers);
            modes.push(...McpDoorAuthenticator.doorModes(methods, verifiers));
        }
        if (oauth) modes.push(oauth);
        McpDoorAuthenticator.refuseOverlaps(modes, oauth);
        for (const mode of modes) if (mode instanceof JwtDoorMode) mode.excluding(modes);
        return new McpDoorAuthenticator(modes, oauth);
    }

    /**
     * Whether a 401 for this request carries the `mcpOAuth(...)` discovery challenge: only when the
     * server has that mode AND the request either carried no credential at all or was classified as an
     * OAuth access token. A rejected `jwt()` / OIDC / api-key credential gets a plain 401, with no hint
     * of which mode came closest.
     */
    challengeApplies(req: McpDoorRequest): boolean {
        if (!this.oauth) return false;
        const claimants = this.modes.filter((mode: McpDoorMode) => mode.claims(req));
        return claimants.length === 0 || (claimants.length === 1 && claimants[0] === this.oauth);
    }

    async authenticate(req: McpDoorRequest): Promise<McpDoorPass> {
        const claimants = this.modes.filter((mode: McpDoorMode) => mode.claims(req));
        if (claimants.length === 0) {
            throw new ApiUnauthorizedError('MCP request has no credential this server accepts.');
        }
        if (claimants.length > 1) {
            throw new ApiUnauthorizedError(
                'MCP request carries more than one credential; send exactly one.',
            );
        }
        return claimants[0].authenticate(req);
    }

    // webpieces-disable no-function-outside-class -- bind-time validation helper of the private constructor
    private static refuseNonCallers(auth: readonly McpHttpAuth[]): void {
        for (const method of auth) {
            if (method.kind === 'vendorAuth' || method.kind === 'public') {
                throw new Error(
                    `WpMcpServerConfig.setAuth([...]) refuses ${method.kind === 'public' ? 'a public mode' : 'vendorAuth(...)'}: ` +
                        'it identifies no caller to authorize tools against. Use oidcSameProject(), oidcSvcs([...]), ' +
                        'jwt(), apiKey(...), sharedSecret(...) or mcpOAuth(...).',
                );
            }
        }
    }

    // webpieces-disable no-function-outside-class -- bind-time validation helper of the private constructor
    private static refuseUnverifiable(
        methods: readonly AuthMethod[],
        verifiers: CredentialVerifiers,
    ): void {
        const missing = methods
            .map((method: AuthMethod) => verifiers.missingVerifier(method))
            .filter((line: string | undefined): line is string => line !== undefined);
        if (missing.length > 0) {
            throw new Error(
                'WpMcpServerConfig.setAuth([...]) accepts a mode this server cannot verify, so it refuses to start. Add:\n    ' +
                    missing.join('\n    '),
            );
        }
    }

    // webpieces-disable no-function-outside-class -- bind-time construction helper of the private constructor
    private static doorModes(
        methods: readonly AuthMethod[],
        verifiers: CredentialVerifiers,
    ): McpDoorMode[] {
        const modes: McpDoorMode[] = [];
        const oidc = methods.filter(
            (method: AuthMethod): method is OidcAuthMethod => method.kind === 'oidc',
        );
        if (oidc[0] !== undefined)
            modes.push(new OidcDoorMode([oidc[0], ...oidc.slice(1)], verifiers));
        for (const method of methods) {
            switch (method.kind) {
                case 'oidc':
                    break;
                case 'jwt':
                    modes.push(new JwtDoorMode(verifiers));
                    break;
                case 'shared-secret':
                    modes.push(new SharedSecretDoorMode(method.secretKey, verifiers));
                    break;
                case 'apikey':
                    modes.push(new ApiKeyDoorMode(method.regime, method.credentials, verifiers));
                    break;
                case 'vendorAuth':
                    throw new ApiImplementationError(
                        'vendorAuth was refused before door modes are built.',
                    );
            }
        }
        return modes;
    }

    /**
     * `claims()` sets must be DISJOINT BY CONSTRUCTION. The bearer space is the only shared one, so the
     * refusals are about it:
     * - `mcpOAuth(..., everyBearer())` claims every bearer, so it stands alone in the bearer family;
     * - a bearer `apiKey(...)` claims every bearer too, so it stands alone as well;
     * - `mcpOAuth(..., jwtIssuer())` may not list a Google issuer beside an OIDC mode.
     * `jwt()` claims the remainder, and `McpAccessTokenFormat.opaquePrefix` refuses a prefix that could
     * overlap a JWT or a dev-oidc token, so nothing else can collide.
     */
    // webpieces-disable no-function-outside-class -- bind-time validation helper of the private constructor
    private static refuseOverlaps(
        modes: readonly McpDoorMode[],
        oauth: McpOAuthDoorMode | undefined,
    ): void {
        const bearerModes = modes.filter((mode: McpDoorMode) => mode.bearerFamily);
        const greedy = bearerModes.filter(
            (mode: McpDoorMode) =>
                mode instanceof ApiKeyDoorMode ||
                (mode instanceof McpOAuthDoorMode && mode.mode.tokenFormat.kind === 'every-bearer'),
        );
        for (const mode of greedy) {
            if (bearerModes.length > 1) {
                const others = bearerModes
                    .filter((other: McpDoorMode) => other !== mode)
                    .map((other: McpDoorMode) => other.name);
                throw new Error(
                    `WpMcpServerConfig.setAuth([...]): ${mode.name} claims EVERY bearer credential, so it overlaps ` +
                        `${others.join(', ')}. Give it a disjoint shape (mcpOAuth: McpAccessTokenFormat.opaquePrefix(...) ` +
                        'or .jwtIssuer(); apiKey: a header credential) or remove the other bearer modes.',
                );
            }
        }
        const oidc = modes.some((mode: McpDoorMode) => mode instanceof OidcDoorMode);
        if (oauth && oidc && oauth.mode.tokenFormat.kind === 'jwt-issuer') {
            const google = oauth.mode.authorizationServers.filter((issuer: string) =>
                GOOGLE_OIDC_ISSUERS.includes(issuer),
            );
            if (google.length > 0) {
                throw new Error(
                    `WpMcpServerConfig.setAuth([...]): mcpOAuth(...) trusts the Google issuer ${google.join(', ')}, ` +
                        'so it overlaps the OIDC mode, which claims every Google-issued token.',
                );
            }
        }
    }
}
