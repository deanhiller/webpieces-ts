import 'reflect-metadata';
import { injectable } from 'inversify';
import {
    ApiEndUserError,
    ApiPath,
    ContextKey,
    ContextTuple,
    Endpoint,
    WpAuthJwt,
    WpAuthOidc,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpMcpAuthJwt,
    WpMcpTool,
    WpResponseDto,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { AuthenticatedCaller, JwtHook, MintedJwt } from '@webpieces/http-routing';
import { McpAccessTokenAuthority, VerifiedMcpCredential } from '../McpAuth';
import { MCP_INVOCATION_CONTEXT } from '../McpInvocationContext';

export const USER_ID = ContextKey.trusted<string>(
    'mcpSpecUserId',
    'proven by a credential verifier',
);
export const ENDPOINT_PATH = '/app-owned/mcp';
export const MODERN_VERSION = '2026-07-28';

@WpDto()
export class SearchRequest {
    @WpDtoField(
        new WpDtoFieldOptions(
            'Search text',
            true,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            'query',
        ),
    )
    query!: string;
}

@WpDto()
export class SearchResponse {
    @WpDtoField(new WpDtoFieldOptions('Authenticated user', true))
    userId!: string;

    @WpDtoField(new WpDtoFieldOptions('Search result', true))
    result!: string;
}

@ApiPath('/mcp-spec')
export abstract class SearchApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'account_search',
        description: 'Search records owned by the authenticated user.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    @WpMcpAuthJwt({ roles: ['admin'] })
    @WpAuthJwt({ roles: ['admin'] })
    @Endpoint('/admin', 'rpc')
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'admin_search',
        description: 'Administrative search.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    })
    admin(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/remote-spec')
export abstract class RemoteSearchApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc()
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'remote_search',
        description: 'Search a remote binding.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    })
    search(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

@injectable()
export class SearchController extends SearchApi {
    static waitStartedHook?: () => void;
    static waitAbortedHook?: () => void;
    adminInvocations = 0;

    override async search(request: SearchRequest): Promise<SearchResponse> {
        if (request.query === 'internal') throw new Error('database password appeared here');
        if (request.query === 'human') throw new ApiEndUserError('Safe human message', 'SAFE');
        const invocation = RequestContext.getTrusted(MCP_INVOCATION_CONTEXT);
        if (request.query === 'progress') {
            await invocation?.reportProgress?.(1, 2, 'halfway');
        }
        if (request.query === 'wait' && invocation) {
            await invocation.reportProgress?.(0, 1, 'waiting');
            SearchController.waitStartedHook?.();
            await new Promise<void>((resolve: () => void) => {
                const finish = (): void => {
                    SearchController.waitAbortedHook?.();
                    resolve();
                };
                if (invocation.signal.aborted) finish();
                else invocation.signal.addEventListener('abort', finish, { once: true });
            });
        }
        return { userId: RequestContext.getTrusted(USER_ID) ?? 'missing', result: request.query };
    }

    override async admin(request: SearchRequest): Promise<SearchResponse> {
        this.adminInvocations += 1;
        return this.search(request);
    }
}

export class RemoteSearchClient extends RemoteSearchApi {
    seenAuthorization?: string;

    override async search(request: SearchRequest): Promise<SearchResponse> {
        this.seenAuthorization = RequestContext.getRequest()?.getHeader('authorization');
        return { userId: RequestContext.getTrusted(USER_ID) ?? 'missing', result: request.query };
    }
}

export class TestJwtHook extends JwtHook<string> {
    mintedTokens: string[] = [];
    lifetimeSeconds = 60;

    override async mint(subject: string): Promise<MintedJwt> {
        const token =
            subject === 'passthrough'
                ? 'mcp-passthrough'
                : `${subject}-endpoint-${this.mintedTokens.length + 1}`;
        this.mintedTokens.push(token);
        return new MintedJwt(token, Math.floor(Date.now() / 1000) + this.lifetimeSeconds);
    }

    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        if (token.startsWith('admin-endpoint-')) {
            return new AuthenticatedCaller(
                'admin-7',
                ['admin'],
                [new ContextTuple(USER_ID, 'admin-7')],
            );
        }
        if (!token.startsWith('user-endpoint-')) throw new Error('invalid endpoint token');
        return new AuthenticatedCaller('user-7', [], [new ContextTuple(USER_ID, 'user-7')]);
    }
}

export class TestTokenAuthority implements McpAccessTokenAuthority<string> {
    verificationCount = 0;
    roles: readonly string[] = [];

    async mintAccessToken(_grant: string): Promise<never> {
        throw new Error('not used');
    }

    async verifyAccessToken(token: string, resource: string): Promise<VerifiedMcpCredential> {
        this.verificationCount += 1;
        if (token === 'invalid') throw new Error('invalid token');
        const now = Math.floor(Date.now() / 1000);
        const actualResource =
            token === 'wrong-resource' ? 'https://attacker.example/mcp' : resource;
        const subject = token === 'mcp-passthrough' ? 'passthrough' : 'user';
        const issuer =
            token === 'wrong-issuer' ? 'https://attacker.example' : 'https://login.example.test';
        const expiresAt = token === 'expired' ? now - 1 : now + 60;
        const scopes = token === 'missing-scope' ? [] : ['tools'];
        const validatedAt = token === 'stale-account' ? now - 3_601 : now;
        return new VerifiedMcpCredential(
            subject,
            issuer,
            actualResource,
            token === 'expired' ? now - 61 : now,
            expiresAt,
            scopes,
            validatedAt,
            this.roles,
            [new ContextTuple(USER_ID, `${subject}-delegated`)],
        );
    }
}
