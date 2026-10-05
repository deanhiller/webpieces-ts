import { injectable } from 'inversify';
import { RequestContext } from '@webpieces/core-context';
import { ApiForbiddenError, ApiImplementationError, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { AuthorizationHook, CanonicalUserRoles, VERIFIED_MACHINE_CALLER, VerifiedMachineCaller } from '@webpieces/http-routing';

export class CompanyOrganizationPolicy {
    constructor(readonly inOrg: true) {}
}

export class CompanyPartnerPolicy {
    constructor(readonly llmRoles: readonly string[]) {}
}

/** Organization membership is an application policy over verified context. */
@injectable()
export class CompanyAuthorizationHook extends AuthorizationHook<CompanyOrganizationPolicy | CompanyPartnerPolicy> {
    // webpieces-disable no-any-unknown -- startup validates erased decorator payload before producing its typed policy
    override validatePolicy(value: unknown): CompanyOrganizationPolicy | CompanyPartnerPolicy {
        if (value && typeof value === 'object' && 'llmRoles' in value && Object.keys(value).length === 1) {
            const roles = value.llmRoles;
            if (Array.isArray(roles) && roles.length && roles.every((role: unknown) => typeof role === 'string' && role.trim())) {
                return new CompanyPartnerPolicy([...roles]);
            }
        }
        if (!value || typeof value !== 'object' || !('inOrg' in value) || value.inOrg !== true || Object.keys(value).length !== 1) {
            throw new ApiImplementationError('Company CUSTOM policy requires appPolicy: {inOrg: true}.');
        }
        return new CompanyOrganizationPolicy(true);
    }

    override async authorize(policy: CompanyOrganizationPolicy | CompanyPartnerPolicy): Promise<void> {
        if (policy instanceof CompanyPartnerPolicy) {
            const user = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID);
            if (RequestContext.getTrusted(WebpiecesCoreHeaders.SURFACE) === 'llm') {
                if (user?.trim() && policy.llmRoles.some((role: string) => CanonicalUserRoles.read().includes(role))) return;
            } else {
                const machine = RequestContext.getTrusted(VERIFIED_MACHINE_CALLER);
                if (user?.trim() || (machine instanceof VerifiedMachineCaller && machine.isCurrentHop())) return;
            }
            throw new ApiForbiddenError('Partner operation requires an authenticated caller; LLM users require a partner role.');
        }
        const user = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID);
        const org = RequestContext.getTrusted(WebpiecesCoreHeaders.ORG_ID);
        if (!user?.trim() || !org?.trim()) throw new ApiForbiddenError('Endpoint requires a verified user and organization.');
    }
}
