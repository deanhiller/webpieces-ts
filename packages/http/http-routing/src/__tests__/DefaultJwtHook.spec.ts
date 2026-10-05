import {RequestContext} from '@webpieces/core-context';
import {AuthorizationType} from '@webpieces/core-util';
import {AuthorizationService} from '../AuthorizationHook';
import {AuthenticatedCallerContext} from '../AuthenticatedCallerContext';
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { sign } from 'jsonwebtoken';
import { ApiForbiddenError, ApiUnauthorizedError } from '@webpieces/core-util';
import { DefaultJwtHook, DefaultJwtMintRequest } from '../DefaultJwtHook';

const SECRET = 'test-secret-value';

describe('DefaultJwtHook (batteries-included HS256 JwtHook)', () => {
    it('mints and parses a normalized short-lived endpoint JWT', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const minted = await hook.mint(
            new DefaultJwtMintRequest('user-123', ['admin'], 60, { orgId: 'org-9' }),
        );

        const caller = await hook.parseJwt(minted.token);

        expect(minted.expiresAtEpochSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(caller.userId).toBe('user-123');
        expect(caller.roles).toEqual(['admin']);
        expect(caller.claims['orgId']).toBe('org-9');
        expect(caller.claims['jti']).toEqual(expect.any(String));
    });

    it('parses a valid token: sub → userId, roles claim → roles, payload → claims', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ sub: 'user-123', roles: ['admin', 'editor'], orgId: 'org-9' }, SECRET);

        const values = await hook.parseJwt(token);

        expect(values.userId).toBe('user-123');
        expect(values.roles).toEqual(['admin', 'editor']);
        expect(values.claims['orgId']).toBe('org-9');
    });

    it('defaults absent roles to [] and rejects a malformed claim', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const noRoles = await hook.parseJwt(sign({ sub: 'u1' }, SECRET));
        expect(noRoles.roles).toEqual([]);

        await expect(hook.parseJwt(sign({ sub: 'u1', roles: 'admin' }, SECRET))).rejects.toThrow(ApiUnauthorizedError);
    });

    /**
     * REJECTION asserted with `rejects`, never `expect(() => ...).toThrow()`. Now that `parseJwt`
     * returns a promise, the sync form asserts NOTHING: the call returns a rejected promise instead
     * of throwing, `.toThrow` sees no throw and fails — or, worse on a `.not.toThrow`, passes while
     * checking nothing and leaves an unhandled rejection behind.
     */
    it('rejects a token signed with the wrong secret (401)', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ sub: 'u1' }, 'a-different-secret');
        await expect(hook.parseJwt(token)).rejects.toThrow(ApiUnauthorizedError);
    });

    it('rejects an expired token (401)', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ sub: 'u1' }, SECRET, { expiresIn: '-1s' });
        await expect(hook.parseJwt(token)).rejects.toThrow(ApiUnauthorizedError);
    });

    it('rejects a token missing the sub claim (401)', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ roles: ['admin'] }, SECRET);
        await expect(hook.parseJwt(token)).rejects.toThrow(ApiUnauthorizedError);
    });

    it('publishes verified JWT identity into common authorization', async () => {
        const hook = new DefaultJwtHook(SECRET);
        const values = await hook.parseJwt(sign({sub:'u1',roles:['editor']},SECRET));
        await RequestContext.run(async () => {
            new AuthenticatedCallerContext().publish(values);
            const service = new AuthorizationService();
            await expect(service.authorize({authType:AuthorizationType.ALL_USERS})).resolves.toBeUndefined();
            await expect(service.authorize({authType:AuthorizationType.ROLES,roles:['editor','admin']})).resolves.toBeUndefined();
            await expect(service.authorize({authType:AuthorizationType.ROLES,roles:['admin']})).rejects.toThrow(ApiForbiddenError);
        });
    });

    it('admits a verified user without roles through ALL_USERS', async () => {
        const hook = new DefaultJwtHook(SECRET);
        await RequestContext.run(async () => {
            new AuthenticatedCallerContext().publish(await hook.parseJwt(sign({sub:'u1'},SECRET)));
            await expect(new AuthorizationService().authorize({authType:AuthorizationType.ALL_USERS})).resolves.toBeUndefined();
        });
    });

    it('rejects malformed role claims rather than silently dropping them', async () => {
        const hook = new DefaultJwtHook(SECRET);
        for (const roles of [['editor',7],[''], 'admin']) {
            await expect(hook.parseJwt(sign({sub:'u1',roles},SECRET))).rejects.toThrow(ApiUnauthorizedError);
        }
    });
});
