import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { sign } from 'jsonwebtoken';
import { HttpForbiddenError, HttpUnauthorizedError } from '@webpieces/core-util';
import { DefaultJwtHook } from '../DefaultJwtHook';

const SECRET = 'test-secret-value';

describe('DefaultJwtHook (batteries-included HS256 JwtHook)', () => {
    it('parses a valid token: sub → userId, roles claim → roles, payload → claims', () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ sub: 'user-123', roles: ['admin', 'editor'], orgId: 'org-9' }, SECRET);

        const values = hook.parseJwt(token);

        expect(values.userId).toBe('user-123');
        expect(values.roles).toEqual(['admin', 'editor']);
        expect(values.claims['orgId']).toBe('org-9');
    });

    it('defaults roles to [] when the claim is absent or not a string[]', () => {
        const hook = new DefaultJwtHook(SECRET);
        const noRoles = hook.parseJwt(sign({ sub: 'u1' }, SECRET));
        expect(noRoles.roles).toEqual([]);

        const badRoles = hook.parseJwt(sign({ sub: 'u1', roles: 'admin' }, SECRET));
        expect(badRoles.roles).toEqual([]);
    });

    it('rejects a token signed with the wrong secret (401)', () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ sub: 'u1' }, 'a-different-secret');
        expect(() => hook.parseJwt(token)).toThrow(HttpUnauthorizedError);
    });

    it('rejects an expired token (401)', () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ sub: 'u1' }, SECRET, { expiresIn: '-1s' });
        expect(() => hook.parseJwt(token)).toThrow(HttpUnauthorizedError);
    });

    it('rejects a token missing the sub claim (401)', () => {
        const hook = new DefaultJwtHook(SECRET);
        const token = sign({ roles: ['admin'] }, SECRET);
        expect(() => hook.parseJwt(token)).toThrow(HttpUnauthorizedError);
    });

    /**
     * The two branches of the {@link JwtRoles} union, which is the WHOLE contract now: an endpoint
     * either names at least one role or says `allRolesAllowed: true` out loud. The old spelling this
     * assertion used to carry — `authorizeJwt(values, {})` for "any authenticated user" — is gone by
     * construction: `{}` satisfies neither branch, so it is a compile error, and the six bad shapes
     * are pinned in `core-util/src/http/AuthJwtCompileAssertions.ts` rather than re-asserted here (a
     * spec cannot pin a type — vitest strips them).
     */
    it('enforces roles via the inherited authorizeJwt (any-of; allRolesAllowed = any authenticated user)', () => {
        const hook = new DefaultJwtHook(SECRET);
        const values = hook.parseJwt(sign({ sub: 'u1', roles: ['editor'] }, SECRET));

        expect(() => hook.authorizeJwt(values, { allRolesAllowed: true })).not.toThrow();
        expect(() => hook.authorizeJwt(values, { roles: ['editor'] })).not.toThrow();
        expect(() => hook.authorizeJwt(values, { roles: ['editor', 'admin'] })).not.toThrow();
        expect(() => hook.authorizeJwt(values, { roles: ['admin'] })).toThrow(HttpForbiddenError);
    });

    /**
     * The wide branch is wide for AUTHENTICATED users only — it skips the role check, it does not
     * skip authentication (AuthFilter has already run parseJwt by the time this is reached).
     */
    it('allRolesAllowed admits a user carrying NO roles at all', () => {
        const hook = new DefaultJwtHook(SECRET);
        const values = hook.parseJwt(sign({ sub: 'u1' }, SECRET));

        expect(() => hook.authorizeJwt(values, { allRolesAllowed: true })).not.toThrow();
        expect(() => hook.authorizeJwt(values, { roles: ['admin'] })).toThrow(HttpForbiddenError);
    });
});
