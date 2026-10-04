import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { HttpRequest, PendingWireTrust, RequestContext } from '@webpieces/core-context';
import { ApiUnauthorizedError, AuthMeta, ContextKey, READ, RouteMetadata, Service, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { GcpOidc } from '@webpieces/gcp-identity';
import { AuthConfig, AuthenticatedCaller, SharedSecrets } from '../AuthConfig';
import { JwtHook, MintedJwt } from '../AuthHooks';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { AuthFilter } from '../filters/AuthFilter';
import { MethodMeta } from '../MethodMeta';
import { WpResponse } from '../WpResponse';
import { AuthorizationService } from '../AuthorizationHook';
import { AuthorizationType } from '@webpieces/core-util';

const TENANT = ContextKey.trusted<string>('alternativeTenant', 'delegated tenant', 'x-alternative-tenant');
const route = new RouteMetadata('POST', '/mixed', 'mixed', READ, 'MixedController',
    new AuthMeta([{kind:'jwt'}, {kind:'shared-secret', secretKey:'internal'}], undefined), 'MixedApi');

class Credentials extends JwtHook<string> {
    failure: Error = new ApiUnauthorizedError('wrong JWT');
    parses = 0;
    override async mint(_request: string): Promise<MintedJwt> { throw new Error('not used'); }
    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        this.parses++;
        if (token !== 'alice') throw this.failure;
        return new AuthenticatedCaller('alice', []);
    }
}

class PolicyNext implements Service<MethodMeta, WpResponse<object>> {
    invoked = false;
    async invoke(_meta: MethodMeta): Promise<WpResponse<object>> {
        await new AuthorizationService().authorize({authType:AuthorizationType.USERS_OR_SERVICES});
        this.invoked = true;
        return new WpResponse({});
    }
}

describe('authentication alternatives and wire trust', () => {
    async function run(header: string, credentials: Credentials, wireTenant?: string): Promise<PolicyNext> {
        const next = new PolicyNext();
        const filter = new AuthFilter(new DefaultOidcVerifier(new GcpOidc()),
            new AuthConfig({internal:new SharedSecrets('secret', '')}), credentials);
        await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('POST','/mixed',new Map([['authorization',[header]]])));
            if (wireTenant) PendingWireTrust.stash(TENANT, wireTenant);
            await filter.filter(new MethodMeta(route), next);
            if (wireTenant) expect(RequestContext.getTrusted(TENANT)).toBe(wireTenant);
            if (header.startsWith('Webpieces')) expect(RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID)).toBeUndefined();
        });
        return next;
    }

    it('admits either a user JWT or a machine secret through the common policy', async () => {
        expect((await run('Bearer alice', new Credentials())).invoked).toBe(true);
        expect((await run('Webpieces secret', new Credentials(), 'tenant-1')).invoked).toBe(true);
    });

    it('never consumes pending delegated facts while a preceding candidate fails', async () => {
        const credentials = new Credentials();
        await run('Webpieces secret', credentials, 'tenant-2');
        expect(credentials.parses).toBe(0);
    });

    it('rejects forwarded trusted facts when the winning mechanism proves only a user', async () => {
        await expect(run('Bearer alice', new Credentials(), 'forged')).rejects.toThrow(ApiUnauthorizedError);
    });

    it('fails when no declared credential verifies and preserves verifier invariant errors', async () => {
        await expect(run('Bearer wrong', new Credentials())).rejects.toThrow(ApiUnauthorizedError);
        const credentials = new Credentials();
        credentials.failure = new Error('verifier invariant');
        await expect(run('Bearer wrong', credentials)).rejects.toThrow('verifier invariant');
        expect(credentials.parses).toBe(1);
    });
});
