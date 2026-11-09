import {
    AuthenticatedCaller,
    AuthorizationService,
    JwtHook,
    MintedJwt,
} from '@webpieces/http-routing';
import {
    McpAccessTokenAuthority,
    MintedMcpAccessToken,
    VerifiedMcpCredential,
    WpMcpServerConfig,
} from './McpAuth';
import { McpApiBinding } from './McpApiBinding';
import { McpToolset } from './McpToolset';

class ExampleJwtMintRequest {
    constructor(public readonly subject: string) {}
}

class ExampleMcpGrant {
    constructor(
        public readonly subject: string,
        public readonly resource: string,
    ) {}
}

/** Compile assertion: one application authority can own both endpoint JWT and MCP token lifecycles. */
export class McpAuthorityCompileAssertions
    extends JwtHook<ExampleJwtMintRequest>
    implements McpAccessTokenAuthority<ExampleMcpGrant>
{
    override async mint(request: ExampleJwtMintRequest): Promise<MintedJwt> {
        return new MintedJwt(`endpoint:${request.subject}`, Date.now() / 1000 + 60);
    }

    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        return new AuthenticatedCaller(token);
    }

    async mintAccessToken(grant: ExampleMcpGrant): Promise<MintedMcpAccessToken> {
        const now = Math.floor(Date.now() / 1000);
        return new MintedMcpAccessToken(`mcp:${grant.subject}`, grant.resource, now, now + 60);
    }

    async verifyAccessToken(
        _accessToken: string,
        expectedResource: string,
    ): Promise<VerifiedMcpCredential> {
        const now = Math.floor(Date.now() / 1000);
        return new VerifiedMcpCredential(
            'example-user',
            'https://issuer.example.test',
            expectedResource,
            now,
            now + 60,
            ['tools'],
            now,
            new AuthenticatedCaller('example-user'),
        );
    }
}

/** Compiled hard-cut assertions; Vitest does not type-check specifications. */
export class McpPrincipalCompileAssertions {
    roles(credential: VerifiedMcpCredential): readonly string[] {
        // @ts-expect-error listingRoles was replaced by principalRoles derived from the canonical caller
        credential.listingRoles;
        return credential.principalRoles;
    }
}

/** Profile-selection arity is checked by tsc, not only by runtime specs. */
export class McpProfilesCompileAssertions {
    empty(bindings: readonly McpApiBinding[], policy: AuthorizationService): void {
        // @ts-expect-error a toolset must serve at least one profile group
        new McpToolset(bindings, [], policy, []);
    }
}

/**
 * The OAuth-only setters moved into `mcpOAuth(...)` (#1416) and the toolset owns WHICH tools: none of
 * the old spellings compiles, so an agent upgrading is told by tsc, not by a deprecation it never sees.
 */
export class McpServerConfigCompileAssertions {
    removedOAuthSetters(
        config: WpMcpServerConfig,
        authority: McpAccessTokenAuthority<string>,
    ): void {
        // @ts-expect-error moved to mcpOAuth(authority, authorizationServers, requiredScopes, tokenFormat)
        config.setAccessTokenAuthority(authority);
        // @ts-expect-error moved to mcpOAuth(authority, authorizationServers, ...)
        config.setAuthorizationServers(['https://login.example.test']);
        // @ts-expect-error moved to mcpOAuth(authority, authorizationServers, requiredScopes, ...)
        config.setRequiredScopes(['tools']);
        // @ts-expect-error moved to mcpOAuth(..., maxAccountValidationAgeSeconds)
        config.setMaxAccountValidationAgeSeconds(60);
    }

    removedToolsetSetters(config: WpMcpServerConfig, policy: AuthorizationService): void {
        // @ts-expect-error profiles are the McpToolset's: new McpToolset(bindings, catalogs, policy, profiles)
        config.setToolProfiles(['default']);
        // @ts-expect-error the policy is the McpToolset's: new McpToolset(bindings, catalogs, policy, profiles)
        config.setAuthorizationService(policy);
    }
}
