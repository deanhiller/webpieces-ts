import {
    AuthenticatedCaller,
    JwtHook,
    MintedJwt,
} from '@webpieces/http-routing';
import {
    McpAccessTokenAuthority,
    MintedMcpAccessToken,
    VerifiedMcpCredential,
} from './McpAuth';

class ExampleJwtMintRequest {
    constructor(public readonly subject: string) {}
}

class ExampleMcpGrant {
    constructor(public readonly subject: string, public readonly resource: string) {}
}

/** Compile assertion: one application authority can own both endpoint JWT and MCP token lifecycles. */
export class McpAuthorityCompileAssertions extends JwtHook<ExampleJwtMintRequest>
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
        );
    }
}
