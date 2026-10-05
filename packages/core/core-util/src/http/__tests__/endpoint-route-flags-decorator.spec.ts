import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
import 'reflect-metadata';
import {
    ApiPath,
    Endpoint,
    WpAuthPublic,
    getEndpointOptions,
    POST,
    READ,
    RPC,
    WRITE,
} from '../decorators';
import { RouteMetadataFactory } from '../RouteMetadataFactory';

/**
 * `@Endpoint(..., { hideProgress, noLogging, allowUpgradeInFlight })` must each reach the matching
 * `RouteMetadata` field (#1148, which split #976's single `background` bit into three independent
 * decisions). A browser app's `RequestLifecycleListener` reads `hideProgress` / `allowUpgradeInFlight`
 * from the route; {@link LogApiCallImpl} reads `noLogging` (via ApiMethodInfo).
 *
 * Every assertion is pinned in BOTH directions — a flagged endpoint AND an ordinary one beside it —
 * and each flag is declared ALONE on one endpoint, so no flag can rot into a constant or into a
 * copy of its neighbour while the suite still passes.
 */
@ApiPath('/api/web/devlog')
abstract class SampleDevLogApi {
    /** The log shipper: all three, exactly what `background: true` used to mean. */
    @WpAuthPublic('Browser log shipping fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Browser log shipping fixture' })
    @Endpoint(POST, '/batch', WRITE, RPC, { hideProgress: true, noLogging: true, allowUpgradeInFlight: true })
    sendBatch(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    /** A background download: hidden from the bar, still logged, still blocks an upgrade. */
    @WpAuthPublic('Hidden download fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Hidden download fixture' })
    @Endpoint(POST, '/manifest', READ, RPC, { hideProgress: true })
    manifest(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    /** Only noLogging. */
    @WpAuthPublic('Quiet route fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Quiet route fixture' })
    @Endpoint(POST, '/quiet', READ, RPC, { noLogging: true })
    quiet(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    /** Only allowUpgradeInFlight. */
    @WpAuthPublic('Upgrade-safe route fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Upgrade-safe route fixture' })
    @Endpoint(POST, '/heartbeat', READ, RPC, { allowUpgradeInFlight: true })
    heartbeat(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    /** An ordinary route on the same contract — the control for every assertion below. */
    @WpAuthPublic('Ordinary route fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Ordinary route fixture' })
    @Endpoint(POST, '/ping', READ, RPC)
    ping(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@Endpoint hideProgress / noLogging / allowUpgradeInFlight options', () => {
    /** The three flags of one route, as a comparable tuple: [hideProgress, noLogging, allowUpgradeInFlight]. */
    const flagsOf = (methodName: string, controllerClassName?: string): readonly boolean[] => {
        const route = RouteMetadataFactory.create(SampleDevLogApi, methodName, controllerClassName);
        return [route.hideProgress, route.noLogging, route.allowUpgradeInFlight];
    };

    it('round-trip in the parallel endpoint-options metadata, and are absent when undeclared', () => {
        expect(getEndpointOptions(SampleDevLogApi, 'sendBatch')).toEqual({
            hideProgress: true,
            noLogging: true,
            allowUpgradeInFlight: true,
        });
        expect(getEndpointOptions(SampleDevLogApi, 'manifest')).toEqual({ hideProgress: true });
        expect(getEndpointOptions(SampleDevLogApi, 'ping')).toEqual({});
    });

    it('ride a CLIENT route (no controller name), each independently, default false', () => {
        expect(flagsOf('sendBatch')).toEqual([true, true, true]);
        expect(flagsOf('manifest')).toEqual([true, false, false]);
        expect(flagsOf('quiet')).toEqual([false, true, false]);
        expect(flagsOf('heartbeat')).toEqual([false, false, true]);
        expect(flagsOf('ping')).toEqual([false, false, false]);
    });

    it('ride a SERVER route (built with its controller name), each independently, default false', () => {
        expect(flagsOf('sendBatch', 'DevLogController')).toEqual([true, true, true]);
        expect(flagsOf('manifest', 'DevLogController')).toEqual([true, false, false]);
        expect(flagsOf('quiet', 'DevLogController')).toEqual([false, true, false]);
        expect(flagsOf('heartbeat', 'DevLogController')).toEqual([false, false, true]);
        expect(flagsOf('ping', 'DevLogController')).toEqual([false, false, false]);
    });

    it('survive the per-call clone a client makes when it selects its credential', () => {
        const shipper = RouteMetadataFactory.create(SampleDevLogApi, 'manifest');
        const firstMode = shipper.authMeta?.methods[0];
        if (!firstMode) throw new Error('fixture declares @WpAuthPublic');
        const selected = shipper.withSelectedAuth(firstMode);
        expect([selected.hideProgress, selected.noLogging, selected.allowUpgradeInFlight]).toEqual([
            true,
            false,
            false,
        ]);
    });

    it('leave the neighbouring route flags untouched — one declaration, one meaning', () => {
        const shipper = RouteMetadataFactory.create(SampleDevLogApi, 'sendBatch');
        expect(shipper.formPost).toBe(false);
        expect(shipper.rawBody).toBe(false);
        expect(shipper.path).toBe('/api/web/devlog/batch');
    });
});
