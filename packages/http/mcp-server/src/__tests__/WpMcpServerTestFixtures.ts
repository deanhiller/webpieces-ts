import 'reflect-metadata';
import { injectable } from 'inversify';
import {
    ApiBadRequestError,
    ApiBadGatewayError,
    ApiConnectionError,
    ApiDependencyBackoffError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiEndUserError,
    ApiPath,
    ApiUnauthorizedError,
    ApiUnavailableError,
    Logger,
    LoggerFactory,
    LogLevel,
    ContextKey,
    ContextTuple,
    Endpoint,
    WpAuthJwt,
    WpAuthOidc,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpMcpAuthJwt,
    WpMcpHeader,
    WpMcpTool,
    WpResponseDto,
    POST,
    READ,
    RPC,
    WRITE,
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
/** What every shipping MCP client opens with today — the top of the 2025 negotiation table. */
export const LEGACY_VERSION = '2025-11-25';
/** An older 2025-era revision the negotiation table still carries. */
export const OLDER_LEGACY_VERSION = '2025-03-26';
/** A revision NO era knows: the one case a server is still right to refuse. */
export const UNKNOWN_VERSION = '1999-01-01';

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
            new WpMcpHeader('query'),
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
    @Endpoint(POST, '/search', READ, RPC)
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'account_search',
        description: 'Search records owned by the authenticated user.',
        openWorldHint: false,
    })
    search(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    @WpMcpAuthJwt({ roles: ['admin'] })
    @WpAuthJwt({ roles: ['admin'] })
    @Endpoint(POST, '/admin', WRITE, RPC)
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'admin_search',
        description: 'Administrative search.',
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
    @Endpoint(POST, '/search', WRITE, RPC)
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'remote_search',
        description: 'Search a remote binding.',
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
        // A DOWNSTREAM call of ours failed. From the model's seat that is OUR bug, never a kind of
        // its own on the wire — see #959 and ApiErrorBoundary.encode.
        if (request.query === 'downstream') {
            throw new ApiConnectionError('ECONNREFUSED private-host:8443');
        }
        if (request.query === 'human') throw new ApiEndUserError('Safe human message', 'SAFE');
        if (request.query === 'malformed') {
            throw new ApiBadRequestError(
                'operator-only: column tenant_7 rejected',
                '$.query',
                'query is malformed',
            );
        }
        if (request.query === 'dependency') throw new ApiDependencyError('private upstream');
        if (request.query === 'bad-gateway') throw new ApiBadGatewayError('private proxy');
        if (request.query === 'timeout') throw new ApiDependencyTimeoutError('private timeout');
        if (request.query === 'backoff') {
            throw new ApiDependencyBackoffError('private throttling detail', 37);
        }
        if (request.query === 'unavailable') throw new ApiUnavailableError('private deployment');
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
    failWith?: Error;

    override async mint(subject: string): Promise<MintedJwt> {
        if (this.failWith) throw this.failWith;
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
        if (token === 'invalid') throw new ApiUnauthorizedError('invalid token');
        if (token === 'authority-bug') throw new Error('SECRET-internal-detail');
        const now = Math.floor(Date.now() / 1000);
        const actualResource =
            token === 'wrong-resource' ? 'https://attacker.example/mcp' : resource;
        const subject = token.startsWith('mcp-admin')
            ? 'admin'
            : token === 'mcp-passthrough'
              ? 'passthrough'
              : 'user';
        const issuer =
            token === 'wrong-issuer' ? 'https://attacker.example' : 'https://login.example.test';
        const expiresAt = token === 'expired' ? now - 1 : now + 60;
        const scopes = token === 'missing-scope' ? [] : ['tools'];
        const validatedAt = token === 'stale-account' ? now - 3_601 : now;
        const credential = new VerifiedMcpCredential(
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
        if (token === 'list-bug') {
            Object.defineProperty(credential, 'listingRoles', {
                get: (): readonly string[] => {
                    throw new Error('SECRET-internal-detail');
                },
            });
        }
        return credential;
    }
}

export class RecordedLogLine {
    constructor(
        public readonly logger: string,
        public readonly level: LogLevel,
        public readonly message: string,
        public readonly error?: Error,
    ) {}

    /** The rendered line an operator would see, including an attached error's message and stack. */
    rendered(): string {
        return `${this.message} ${this.error?.message ?? ''} ${this.error?.stack ?? ''}`;
    }
}

class RecordingLogger implements Logger {
    constructor(
        private readonly name: string,
        private readonly lines: RecordedLogLine[],
    ) {}

    trace(message: string, err?: Error): void {
        this.lines.push(new RecordedLogLine(this.name, 'trace', message, err));
    }

    debug(message: string, err?: Error): void {
        this.lines.push(new RecordedLogLine(this.name, 'debug', message, err));
    }

    info(message: string, err?: Error): void {
        this.lines.push(new RecordedLogLine(this.name, 'info', message, err));
    }

    warn(message: string, err?: Error): void {
        this.lines.push(new RecordedLogLine(this.name, 'warn', message, err));
    }

    error(message: string, err?: Error): void {
        this.lines.push(new RecordedLogLine(this.name, 'error', message, err));
    }
}

/** Captures every log line in-process so tests can count and level-check operator output. */
export class RecordingLoggerFactory implements LoggerFactory {
    readonly lines: RecordedLogLine[] = [];

    getLogger(name: string): Logger {
        return new RecordingLogger(name, this.lines);
    }

    containing(text: string): RecordedLogLine[] {
        return this.lines.filter((line: RecordedLogLine) => line.rendered().includes(text));
    }
}
