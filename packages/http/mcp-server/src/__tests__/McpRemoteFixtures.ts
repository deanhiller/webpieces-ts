import 'reflect-metadata';
import { injectable } from 'inversify';
import {
    ApiBadRequestError,
    ApiCodedError,
    ApiConflictError,
    ApiConnectionError,
    ApiDependencyBackoffError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiEndpointNotFoundError,
    ApiEndUserError,
    ApiErrorCodec,
    ApiErrorHttpStatus,
    ApiForbiddenError,
    ApiImplementationError,
    ApiNotFoundError,
    ApiNotImplementedError,
    ApiPath,
    ApiPreconditionFailedError,
    ApiRateLimitedError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
    ApiUnavailableError,
    ApiUnprocessableError,
    ApiUnsupportedMediaTypeError,
    ContextKey,
    Endpoint,
    ErrorTranslator,
    Filter,
    WebpiecesDefaultErrorTranslator,
    HttpResponseDto,
    LogLevel,
    Service,
    WebpiecesCoreHeaders,
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
import { MethodMeta, OidcHook, WpResponse } from '@webpieces/http-routing';


/** Contracts, controllers and test doubles for McpRemoteBinding.integration.spec.ts. */

export const REMOTE_USER = ContextKey.trusted<string>(
    'mcpRemoteUser',
    'verified by the MCP access-token authority before delegation',
    'x-mcp-remote-user',
);
export const REMOTE_ROLES = ContextKey.trusted<string>(
    'mcpRemoteRoles',
    'verified by the MCP access-token authority before delegation',
    'x-mcp-remote-roles',
);
export const REMOTE_SERVICE = 'mcp-remote-integration';
export const REFUSED_SERVICE = 'mcp-remote-refused';
export const GARBAGE_SERVICE = 'mcp-remote-garbage';
export const OIDC_TOKEN = 'oidc-for-mcp-remote-integration';
export const EXTERNAL_MCP_BEARER = 'external-mcp-access-token';
export const LOCAL_ENDPOINT_JWT = 'local-endpoint-jwt-that-must-not-cross-the-remote-hop';
export const GATEWAY_PATH = '/gateway/mcp';

@WpDto()
export class RemoteRequest {
    @WpDtoField(new WpDtoFieldOptions('Search text', true))
    query!: string;

    constructor(query?: string) {
        if (query !== undefined) this.query = query;
    }
}

@WpDto()
export class RemoteResponse {
    @WpDtoField(new WpDtoFieldOptions('Delegated user', true))
    user!: string;

    @WpDtoField(new WpDtoFieldOptions('Delegated roles', true))
    roles!: string;

    @WpDtoField(new WpDtoFieldOptions('Result', true))
    result!: string;

    constructor(user?: string, roles?: string, result?: string) {
        if (user !== undefined) this.user = user;
        if (roles !== undefined) this.roles = roles;
        if (result !== undefined) this.result = result;
    }
}

@ApiPath('/remote-mcp')
export abstract class RemoteMcpApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'remote_integration_search',
        description: 'Calls a remote Webpieces API.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/missing-remote-mcp')
export abstract class MissingRemoteMcpApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'missing_remote_integration_search',
        description: 'Intentionally absent route.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/refused-remote-mcp')
export abstract class RefusedRemoteApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'refused_remote',
        description: 'Nothing listens on this port.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/garbage-remote-mcp')
export abstract class GarbageRemoteApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'garbage_remote',
        description: 'Answers an undecodable body.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/oidc-fail-remote-mcp')
export abstract class OidcFailRemoteApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'oidc_fail_remote',
        description: 'Its OIDC token cannot be minted.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/local-throw')
export abstract class LocalThrowApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/throw', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'local_throw',
        description: 'Throws the requested failure in-process.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    fail(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/remote-throw')
export abstract class RemoteThrowApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/throw', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'remote_throw',
        description: 'Throws the requested failure remotely.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    fail(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

/**
 * One named throw, run identically behind the local and the remote binding.
 *
 * `expectedServerLevel` is the level of the ONE operator line the failure now produces on the server
 * that raised it — `LogApiCall`'s, at `warn` for `[API-server-resp-OTHER]` (a healthy rejection of
 * the caller's mistake) and `error` for `[API-server-resp-FAIL]`. `ApiErrorBoundary` no longer
 * writes a second line of its own (#961).
 */
export class ThrowCase {
    constructor(
        public readonly name: string,
        public readonly expectedKind: string,
        public readonly expectedServerLevel: LogLevel,
        public readonly raise: () => never,
    ) {}
}

export const THROW_CASES: readonly ThrowCase[] = [
    new ThrowCase('end-user', 'end-user', 'warn', () => {
        throw new ApiEndUserError('The two passwords you entered do not match.', 'PW_MISMATCH');
    }),
    new ThrowCase('bad-request', 'bad-request', 'warn', () => {
        throw new ApiBadRequestError('internal column name', '$.query', 'query must be a word');
    }),
    new ThrowCase('unauthorized', 'unauthorized', 'warn', () => {
        throw new ApiUnauthorizedError('session internals');
    }),
    new ThrowCase('forbidden', 'forbidden', 'warn', () => {
        throw new ApiForbiddenError('acl internals');
    }),
    new ThrowCase('not-found', 'not-found', 'warn', () => {
        throw new ApiNotFoundError('row 7 missing');
    }),
    new ThrowCase('endpoint-not-found', 'endpoint-not-found', 'warn', () => {
        throw new ApiEndpointNotFoundError('route internals');
    }),
    new ThrowCase('request-timeout', 'request-timeout', 'error', () => {
        throw new ApiRequestTimeoutError('slow internals');
    }),
    new ThrowCase('rate-limited', 'rate-limited', 'error', () => {
        throw new ApiRateLimitedError('quota internals');
    }),
    new ThrowCase('conflict', 'conflict', 'warn', () => {
        throw new ApiConflictError('version internals');
    }),
    new ThrowCase('unprocessable', 'unprocessable', 'warn', () => {
        throw new ApiUnprocessableError('rule internals');
    }),
    new ThrowCase('precondition-failed', 'precondition-failed', 'warn', () => {
        throw new ApiPreconditionFailedError('etag internals');
    }),
    new ThrowCase('unsupported-media-type', 'unsupported-media-type', 'warn', () => {
        throw new ApiUnsupportedMediaTypeError('parser internals');
    }),
    new ThrowCase('not-implemented', 'not-implemented', 'error', () => {
        throw new ApiNotImplementedError('feature internals');
    }),
    new ThrowCase('coded-4xx', 'coded', 'warn', () => {
        throw new ApiCodedError('quota internals', 460, 'QUOTA');
    }),
    new ThrowCase('coded-5xx', 'coded', 'error', () => {
        throw new ApiCodedError('disk internals', 507);
    }),
    new ThrowCase('implementation', 'implementation', 'error', () => {
        throw new ApiImplementationError('bug internals');
    }),
    new ThrowCase('dependency', 'dependency', 'error', () => {
        throw new ApiDependencyError('upstream internals');
    }),
    new ThrowCase('unavailable', 'unavailable', 'error', () => {
        throw new ApiUnavailableError('maintenance internals');
    }),
    new ThrowCase('dependency-timeout', 'dependency-timeout', 'error', () => {
        throw new ApiDependencyTimeoutError('upstream slow internals');
    }),
    new ThrowCase('dependency-backoff', 'dependency-backoff', 'error', () => {
        throw new ApiDependencyBackoffError('backoff internals', 42);
    }),
    new ThrowCase('connection', 'implementation', 'error', () => {
        throw new ApiConnectionError('ECONNRESET internals');
    }),
    new ThrowCase('raw-error', 'implementation', 'error', () => {
        throw new Error('SECRET-raw-internals');
    }),
    new ThrowCase('thrown-string', 'implementation', 'error', () => {
        throw 'SECRET-string-internals';
    }),
];

export function raiseFor(query: string): never {
    const found = THROW_CASES.find((candidate: ThrowCase) => candidate.name === query);
    if (!found) throw new Error(`unknown throw case ${query}`);
    return found.raise();
}

@injectable()
export class RemoteMcpController extends RemoteMcpApi {
    calls = 0;
    authorization?: string;

    override search(request: RemoteRequest): Promise<RemoteResponse> {
        this.calls += 1;
        this.authorization = RequestContext.getRequest()?.getHeader('authorization');
        return Promise.resolve(
            new RemoteResponse(
                RequestContext.getTrusted(REMOTE_USER) ?? 'missing-user',
                RequestContext.getTrusted(REMOTE_ROLES) ?? 'missing-roles',
                `remote:${request.query}`,
            ),
        );
    }
}

@injectable()
export class LocalThrowController extends LocalThrowApi {
    override async fail(request: RemoteRequest): Promise<RemoteResponse> {
        return raiseFor(request.query);
    }
}

@injectable()
export class RemoteThrowController extends RemoteThrowApi {
    override async fail(request: RemoteRequest): Promise<RemoteResponse> {
        return raiseFor(request.query);
    }
}

export class RecordingOidcMinter {
    readonly audiences: string[] = [];

    constructor(
        private readonly failure?: Error,
        private readonly token = OIDC_TOKEN,
    ) {}

    mintIdToken(audience: string): Promise<string> {
        this.audiences.push(audience);
        if (this.failure) return Promise.reject(this.failure);
        return Promise.resolve(this.token);
    }
}

export class RecordingOidcVerifier extends OidcHook {
    readonly tokens: string[] = [];
    readonly callerLists: string[][] = [];

    override verifyOidc(token: string, callers: string[]): Promise<void> {
        this.tokens.push(token);
        this.callerLists.push(callers);
        if (token !== OIDC_TOKEN) throw new Error(`unexpected OIDC token '${token}'`);
        return Promise.resolve();
    }
}

@injectable()
export class BoundaryProbeFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    calls = 0;
    sawLogIdentity = false;
    sawTrustedUser?: string;

    override filter(
        meta: MethodMeta,
        next: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        this.calls += 1;
        this.sawLogIdentity =
            RequestContext.getUntrusted(WebpiecesCoreHeaders.CONTROLLER) ===
                'RemoteMcpController' &&
            RequestContext.getUntrusted(WebpiecesCoreHeaders.METHOD) === 'search';
        this.sawTrustedUser = RequestContext.getTrusted(REMOTE_USER);
        return next.invoke(meta);
    }
}

/**
 * The documented gateway opt-out from http-client-node's "a dependency's 4xx is OUR 500" invariant:
 * an MCP gateway relays a Webpieces peer's typed failure so the model sees the same kind it would see
 * for a local binding. `relay = false` answers "not mine", which is the framework default.
 */
export class RelayWebpiecesPeerErrors implements ErrorTranslator {
    relay = true;

    private readonly fallback = new WebpiecesDefaultErrorTranslator();

    toWire(error: Error): HttpResponseDto {
        return this.fallback.toWire(error);
    }

    fromWire(response: HttpResponseDto): void {
        if (this.relay && ApiErrorCodec.isPayload(response.body)) {
            const decoded = ApiErrorCodec.decode(response.body);
            const statusCode = decoded instanceof ApiCodedError ? decoded.statusCode : undefined;
            if (
                ApiErrorHttpStatus.hasCode(decoded) &&
                ApiErrorHttpStatus.codeFor(decoded.kind, statusCode) === response.status.code
            ) {
                throw decoded;
            }
        }
        this.fallback.fromWire(response);
    }
}
