import { injectable } from 'inversify';
import jwt from 'jsonwebtoken';
import { JwtHook, AuthenticatedCaller, MintedJwt } from '@webpieces/http-routing';
import {
    ContextTuple,
    ApiUnauthorizedError,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';

/** Company JWT authority verifies claims; application authorization runs in CompanyAuthorizationHook. */
export class CompanyJwtMintRequest {
    constructor(
        public readonly userId: string,
        public readonly roles: readonly string[],
        public readonly expiresInSeconds: number,
    ) {}
}

@injectable()
export class CompanyJwtHook extends JwtHook<CompanyJwtMintRequest> {
    private readonly jwtSecret = process.env['JWT_SECRET'] ?? 'dev-insecure-jwt-secret-change-me';

    override async mint(request: CompanyJwtMintRequest): Promise<MintedJwt> {
        const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + request.expiresInSeconds;
        const token = jwt.sign(
            // webpieces-disable no-anonymous-object-literals -- jsonwebtoken claim bag
            { roles: request.roles },
            this.jwtSecret,
            { subject: request.userId, expiresIn: request.expiresInSeconds },
        );
        return new MintedJwt(token, expiresAtEpochSeconds);
    }

    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        const claims = this.decode(token);
        const subject = claims['sub'] ?? claims['userId'];
        if (typeof subject !== 'string' || !subject.trim()) {
            throw new ApiUnauthorizedError('JWT has no subject (sub/userId) claim');
        }
        const userId = subject;
        const rawRoles = claims['roles'] ?? [];
        // webpieces-disable no-any-unknown -- verified external JWT claim elements require runtime validation
        if (!Array.isArray(rawRoles) || !rawRoles.every((role: unknown) => typeof role === 'string' && role.trim())) {
            throw new ApiUnauthorizedError('JWT roles must be nonempty strings');
        }
        const roles: string[] = rawRoles;
        const entries = [new ContextTuple(WebpiecesCoreHeaders.USER_ID, userId)];
        const orgId = claims['orgId'];
        if (typeof orgId === 'string' && orgId.trim()) entries.push(new ContextTuple(WebpiecesCoreHeaders.ORG_ID, orgId));
        return new AuthenticatedCaller(
            userId,
            roles,
            entries,
            claims,
        );
    }

    // webpieces-disable no-any-unknown -- jwt claims are an arbitrary provider-defined bag
    private decode(token: string): Record<string, unknown> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- jwt.verify throws on a bad token; translated to a managed 401 here
        try {
            const payload = jwt.verify(token, this.jwtSecret);
            if (typeof payload === 'object' && payload !== null) {
                // webpieces-disable no-any-unknown -- jwt payload is an arbitrary claims object
                return payload as Record<string, unknown>;
            }
            return {};
        } catch (err: unknown) {
            const error = toError(err);
            throw new ApiUnauthorizedError('Invalid JWT token', undefined, error);
        }
    }
}
