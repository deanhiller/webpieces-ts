import 'reflect-metadata';
import { injectable } from 'inversify';
import {
    ApiPath,
    ApiType,
    ApiUnauthorizedError,
    AuthorizationType,
    ContextKey,
    Endpoint,
    getWpMcpTools,
    jwt,
    MCP,
    McpToolCatalogFile,
    McpToolDefinition,
    mcpHintsForOperation,
    OidcAuthMethods,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WebpiecesCoreHeaders,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    WpMcpToolMetadata,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import {
    ApiKeyHook,
    AuthenticatedCaller,
    AuthenticatedCallerContext,
    AuthenticatedMachineIdentity,
    JwtHook,
    MintedJwt,
    OidcHook,
} from '@webpieces/http-routing';
import { McpAccessTokenAuthority, VerifiedMcpCredential } from '../McpAuth';
import { McpToolCatalog } from '../McpToolCatalog';
import { SEARCH_API_CATALOG, SearchRequest, SearchResponse } from './WpMcpServerTestFixtures';

/**
 * One contract served over every transport. `stores_pause` needs the OPERATOR role and `stores_purge`
 * is in the `admin` profile only, so projection by caller AND by toolset profile are both visible.
 * The endpoints declare plain `jwt()`: an MCP transport never needs an endpoint auth mode of its own.
 */
@ApiPath('/stores')
@ApiType(SVC_TO_SVC, MCP)
export abstract class StoreApi {
    /**
     * List the caller's stores.
     *
     * @summary List stores
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/list', READ, RPC)
    @WpMcpTool('stores_list', { profiles: ['user'] })
    list(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    /**
     * Pause a store.
     *
     * @summary Pause store
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['OPERATOR'] })
    @Endpoint(POST, '/pause', READ, RPC)
    @WpMcpTool('stores_pause', { profiles: ['user'] })
    pause(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    /**
     * Purge a store; admin profile only.
     *
     * @summary Purge store
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['OPERATOR'] })
    @Endpoint(POST, '/purge', READ, RPC)
    @WpMcpTool('stores_purge', { profiles: ['admin'] })
    purge(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

/** A contract that marks a SERVICE_ONLY method as an MCP tool, which `McpToolset` must refuse. */
@ApiPath('/service-only')
@ApiType(SVC_TO_SVC, MCP)
export abstract class ServiceOnlyToolApi {
    /**
     * Only for a bare service hop.
     *
     * @summary Service only
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/run', READ, RPC)
    @WpMcpTool('service_only')
    run(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

@injectable()
export class ServiceOnlyToolController extends ServiceOnlyToolApi {
    override async run(request: SearchRequest): Promise<SearchResponse> {
        const response = new SearchResponse();
        response.userId = 'service';
        response.result = request.query;
        return response;
    }
}

/** A hold the test releases, so a call is provably still in flight while another caller runs. */
export class StoreGate {
    private release?: () => void;
    readonly entered: Promise<void>;
    private enter!: () => void;
    readonly opened: Promise<void>;

    constructor() {
        this.entered = new Promise<void>((resolve: () => void) => {
            this.enter = resolve;
        });
        this.opened = new Promise<void>((resolve: () => void) => {
            this.release = resolve;
        });
    }

    async pass(): Promise<void> {
        this.enter();
        await this.opened;
    }

    open(): void {
        this.release?.();
    }
}

@injectable()
export class StoreController extends StoreApi {
    static gate?: StoreGate;
    static readonly calls: string[] = [];

    override async list(request: SearchRequest): Promise<SearchResponse> {
        return this.answer('list', request);
    }

    override async pause(request: SearchRequest): Promise<SearchResponse> {
        if (request.query === 'hold') await StoreController.gate?.pass();
        return this.answer('pause', request);
    }

    override async purge(request: SearchRequest): Promise<SearchResponse> {
        return this.answer('purge', request);
    }

    private answer(method: string, request: SearchRequest): SearchResponse {
        StoreController.calls.push(method);
        const response = new SearchResponse();
        response.userId = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID) ?? 'missing';
        response.result = request.query;
        return response;
    }
}

const SCHEMA = SEARCH_API_CATALOG.file.tools[0];
export const STORE_CATALOG = new McpToolCatalog(
    new McpToolCatalogFile(
        'StoreApi',
        getWpMcpTools(StoreApi).map(
            (tool: WpMcpToolMetadata) =>
                new McpToolDefinition(
                    tool.name,
                    `Store ${tool.name}`,
                    tool.methodName,
                    'Store fixture',
                    mcpHintsForOperation(READ, false),
                    SCHEMA.inputSchema,
                    SCHEMA.outputSchema,
                    tool.profiles,
                ),
        ),
    ),
    '(store fixture)',
);

export const SAME_PROJECT_SA = 'ai-chat@this-project.iam.gserviceaccount.com';
export const OTHER_PROJECT_SA = 'intruder@other-project.iam.gserviceaccount.com';
export const OAUTH_ISSUER = 'https://login.example.test';
export const PARTNER_KEY = ContextKey.untrusted<string>('mcpPartnerKey', 'x-partner-key');

/** The unsigned off-GCP OIDC token `@webpieces/gcp-identity` mints, for `email`. */
export class DevOidcTokens {
    // webpieces-disable no-function-outside-class -- test token builder
    static of(email: string, audience = 'https://svc-b.example.test'): string {
        return (
            'dev-oidc.' +
            Buffer.from(JSON.stringify({ email, aud: audience }), 'utf8').toString('base64url')
        );
    }

    /** A JWT that merely CLAIMS to be Google-issued; its signature is garbage. */
    // webpieces-disable no-function-outside-class -- test token builder
    static forgedGoogleJwt(): string {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
            'base64url',
        );
        const payload = Buffer.from(
            JSON.stringify({ iss: 'https://accounts.google.com', email: SAME_PROJECT_SA }),
        ).toString('base64url');
        return `${header}.${payload}.forged-signature`;
    }
}

/**
 * The OIDC verifier edge: admits a dev token whose email is a service account of `this-project`, the
 * way `oidcSameProject()` admits this GCP project's accounts. Anything else — another project, or a
 * JWT whose Google signature it cannot verify — is a 401.
 */
export class ProjectOidcHook extends OidcHook {
    readonly tokens: string[] = [];

    override async verifyOidc(
        token: string,
        _methods: OidcAuthMethods,
    ): Promise<AuthenticatedMachineIdentity> {
        this.tokens.push(token);
        if (!token.startsWith('dev-oidc.'))
            throw new ApiUnauthorizedError('OIDC signature did not verify');
        const claims = JSON.parse(
            Buffer.from(token.substring('dev-oidc.'.length), 'base64url').toString('utf8'),
        ) as Record<string, string>;
        if (!claims['email']?.endsWith('@this-project.iam.gserviceaccount.com')) {
            throw new ApiUnauthorizedError('OIDC caller is not a service account of this project');
        }
        return new AuthenticatedMachineIdentity('oidc', claims['email']);
    }
}

/** The app's own user JWT: `jwt-alice` is an OPERATOR, `jwt-bob` has no role. Records every token. */
export class TransportJwtHook extends JwtHook<string> {
    readonly parsed: string[] = [];

    override async mint(_subject: string): Promise<MintedJwt> {
        throw new Error('not used');
    }

    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        this.parsed.push(token);
        if (token === 'jwt-alice') return new AuthenticatedCaller('alice', ['OPERATOR']);
        if (token === 'jwt-bob') return new AuthenticatedCaller('bob', []);
        throw new ApiUnauthorizedError('invalid user token');
    }
}

/** A partner's api key on its own header. */
export class TransportApiKeyHook extends ApiKeyHook {
    override async verifyApiKey(
        _regime: string,
        request: HttpRequest,
    ): Promise<AuthenticatedCaller> {
        if (request.getHeader('x-partner-key') === 'key-carol') {
            return new AuthenticatedCaller('carol', ['OPERATOR']);
        }
        throw new ApiUnauthorizedError('unknown partner key');
    }
}

/** MCP OAuth access tokens minted as opaque `wpmcp_<user>` strings. */
export class PrefixTokenAuthority implements McpAccessTokenAuthority<string> {
    async mintAccessToken(_grant: string): Promise<never> {
        throw new Error('not used');
    }

    async verifyAccessToken(token: string, resource: string): Promise<VerifiedMcpCredential> {
        if (token !== 'wpmcp_dave') throw new ApiUnauthorizedError('invalid access token');
        const now = Math.floor(Date.now() / 1000);
        return new VerifiedMcpCredential(
            'dave',
            OAUTH_ISSUER,
            resource,
            now,
            now + 60,
            ['tools'],
            now,
            new AuthenticatedCaller('dave', ['OPERATOR']),
        );
    }
}

/**
 * Runs `work` as a caller an endpoint's AuthFilter already verified: one request scope with the user
 * published and ingress completed — exactly the context an in-process agent calls its client from.
 */
export class VerifiedCaller {
    constructor(
        public readonly userId: string,
        public readonly roles: string[],
    ) {}

    async run<T>(work: () => Promise<T>): Promise<T> {
        return RequestContext.run(async () => {
            new RequestContextHeaders().fillFromRequest(
                new HttpRequest('POST', '/chat', new Map()),
            );
            const context = new AuthenticatedCallerContext();
            context.publish(new AuthenticatedCaller(this.userId, this.roles));
            context.reconcileWireTrust(false);
            return work();
        });
    }
}
