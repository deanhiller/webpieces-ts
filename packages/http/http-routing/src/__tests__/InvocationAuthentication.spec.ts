import { describe, expect, it } from 'vitest';
import { RequestContext } from '@webpieces/core-context';
import { ApiForbiddenError, ApiImplementationError, AuthorizationType, READ, RouteMetadata, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { AuthenticatedCaller } from '../AuthConfig';
import { AuthenticatedCallerContext } from '../AuthenticatedCallerContext';
import { AuthorizationService, VERIFIED_MACHINE_CALLER, VerifiedMachineCaller } from '../AuthorizationHook';
import { InvocationAuthentication } from '../InvocationAuthentication';

class TargetApi {}
class OtherApi {}

function target(apiClass: Function = TargetApi, methodName = 'read'): RouteMetadata {
    const route = new RouteMetadata('POST','/target',methodName,READ);
    route.apiClass = apiClass;
    return route;
}

describe('local invocation proof lifetime', () => {
    it('rejects ambient user identity without completed verified ingress', () => {
        RequestContext.run(() => {
            RequestContext.putTrusted(WebpiecesCoreHeaders.USER_ID, 'alice');
            expect(() => new InvocationAuthentication(TargetApi,'read')).toThrow(ApiImplementationError);
        });
    });

    it('binds proof to the actual API constructor and method', () => {
        RequestContext.run(() => {
            const ingress = new AuthenticatedCallerContext();
            ingress.publish(new AuthenticatedCaller('alice'));
            ingress.reconcileWireTrust(false);
            const proof = new InvocationAuthentication(TargetApi,'read');
            expect(() => proof.assertTarget(target())).not.toThrow();
            expect(() => proof.assertTarget(target(OtherApi))).toThrow(ApiImplementationError);
            expect(() => proof.assertTarget(target(TargetApi,'write'))).toThrow(ApiImplementationError);
        });
    });

    it('rejects a proof in a restored snapshot or after restoring into the same scope', () => {
        RequestContext.run(() => {
            const ingress = new AuthenticatedCallerContext();
            ingress.publish(new AuthenticatedCaller('alice'));
            ingress.reconcileWireTrust(false);
            const proof = new InvocationAuthentication(TargetApi,'read');
            const captured = RequestContext.copyContext().withTrusted();
            RequestContext.runWithContext(captured, () => {
                expect(RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID)).toBe('alice');
                expect(() => proof.assertTarget(target())).toThrow(ApiImplementationError);
                expect(() => new InvocationAuthentication(TargetApi,'read')).toThrow(ApiImplementationError);
            });
            expect(() => proof.assertTarget(target())).not.toThrow();
            RequestContext.restoreContext(captured);
            expect(() => proof.assertTarget(target())).toThrow(ApiImplementationError);
        });
    });

    it('does not turn captured machine evidence into current-hop authentication', async () => {
        await RequestContext.run(async () => {
            RequestContext.putTrusted(VERIFIED_MACHINE_CALLER, new VerifiedMachineCaller('oidc','worker@example.test'));
            const service = new AuthorizationService();
            await service.authorize({authType:AuthorizationType.SERVICE_ONLY});
            const captured = RequestContext.copyContext().withTrusted();
            await RequestContext.runWithContext(captured, async () => {
                await expect(service.authorize({authType:AuthorizationType.SERVICE_ONLY})).rejects.toThrow(ApiForbiddenError);
            });
        });
    });
});
