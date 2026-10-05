import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '@webpieces/core-context';
import { ApiForbiddenError, AuthorizationType, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { AuthorizationHook, AuthorizationService, VERIFIED_MACHINE_CALLER, VerifiedMachineCaller } from '../AuthorizationHook';

class PermissionPolicy {
    constructor(readonly permission: string) {}
}

class PermissionHook extends AuthorizationHook<PermissionPolicy> {
    validations = 0;
    evaluations = 0;

    // webpieces-disable no-any-unknown -- application-owned runtime shape validator
    override validatePolicy(value: unknown): PermissionPolicy {
        this.validations++;
        if (!(value instanceof PermissionPolicy)) throw new Error('Unsupported permission declaration.');
        return value;
    }

    override async authorize(policy: PermissionPolicy): Promise<void> {
        this.evaluations++;
        if (RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID) !== policy.permission) {
            throw new ApiForbiddenError('Permission denied.');
        }
    }
}

describe('common authorization service', () => {
    it('ALL_USERS admits a verified user with no organization or role requirement', async () => {
        await RequestContext.run(async () => {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'alice');
            await new AuthorizationService().authorize({ authType: AuthorizationType.ALL_USERS });
        });
    });

    it('rejects missing and blank user identity', async () => {
        await RequestContext.run(async () => {
            const service = new AuthorizationService();
            await expect(service.authorize({ authType: AuthorizationType.ALL_USERS })).rejects.toThrow(ApiForbiddenError);
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, ' ');
            await expect(service.authorize({ authType: AuthorizationType.ALL_USERS })).rejects.toThrow(ApiForbiddenError);
        });
    });

    it('ROLES implements any-of against the canonical JSON role array', async () => {
        await RequestContext.run(async () => {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'alice');
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ROLES, JSON.stringify(['editor']));
            const service = new AuthorizationService();
            await service.authorize({ authType: AuthorizationType.ROLES, roles: ['admin', 'editor'] });
            await expect(service.authorize({ authType: AuthorizationType.ROLES, roles: ['admin'] })).rejects.toThrow(ApiForbiddenError);
        });
    });

    it('a user and an llm surface do not prove SERVICE_ONLY', async () => {
        await RequestContext.run(async () => {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'alice');
            RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, 'llm');
            await expect(new AuthorizationService().authorize({ authType: AuthorizationType.SERVICE_ONLY })).rejects.toThrow(ApiForbiddenError);
        });
    });

    it('machine evidence satisfies service policy without inventing a user', async () => {
        await RequestContext.run(async () => {
            RequestContext.putTrusted(VERIFIED_MACHINE_CALLER, new VerifiedMachineCaller('oidc', 'worker'));
            const service = new AuthorizationService();
            await service.authorize({ authType: AuthorizationType.SERVICE_ONLY });
            await service.authorize({ authType: AuthorizationType.USERS_OR_SERVICES });
            await expect(service.authorize({ authType: AuthorizationType.ALL_USERS })).rejects.toThrow(ApiForbiddenError);
            expect(RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID)).toBeUndefined();
        });
    });

    it('USERS_OR_SERVICES never admits an anonymous caller', async () => {
        await RequestContext.run(async () => {
            await expect(new AuthorizationService().authorize({ authType: AuthorizationType.USERS_OR_SERVICES })).rejects.toThrow(ApiForbiddenError);
        });
    });

    it('CUSTOM requires its hook and validates unsupported policy before serving', () => {
        const policy = { authType: AuthorizationType.CUSTOM, appPolicy: new PermissionPolicy('alice') } as const;
        expect(() => new AuthorizationService().validate(policy)).toThrow('bound AuthorizationHook');
        expect(() => new AuthorizationService(new PermissionHook()).validate({ authType: AuthorizationType.CUSTOM, appPolicy: {} })).toThrow('Unsupported permission');
    });

    it('CUSTOM validates once and evaluates afresh so permission changes invalidate visibility', async () => {
        const hook = new PermissionHook();
        const service = new AuthorizationService(hook);
        const policy = { authType: AuthorizationType.CUSTOM, appPolicy: new PermissionPolicy('alice') } as const;
        service.validate(policy);
        await RequestContext.run(async () => {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'alice');
            await service.authorize(policy);
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'bob');
            await expect(service.authorize(policy)).rejects.toThrow(ApiForbiddenError);
        });
        expect(hook.validations).toBe(1);
        expect(hook.evaluations).toBe(2);
    });

    it('standard branches never call an application hook', async () => {
        const hook = new PermissionHook();
        await RequestContext.run(async () => {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'alice');
            await new AuthorizationService(hook).authorize({ authType: AuthorizationType.ALL_USERS });
        });
        expect(hook.evaluations).toBe(0);
        expect(hook.validations).toBe(0);
    });
});
