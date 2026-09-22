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
 * `@Endpoint(..., { background: true })` must reach `RouteMetadata.background` (#976), which is what
 * a browser app's `RequestLifecycleListener.onRequestStart/onRequestEnd` reads to skip its progress
 * bar, and what {@link LogApiCallImpl} reads (via ApiMethodInfo) to emit no `[API-*]` line.
 *
 * Every assertion is pinned in BOTH directions — the background endpoint AND an ordinary one beside
 * it — so the flag can never rot into a constant `true`/`false` that the suite still accepts.
 */
@ApiPath('/api/web/devlog')
abstract class SampleDevLogApi {
    /** The log shipper itself: its own request/response lines would be the next batch's payload. */
    @WpAuthPublic('Browser log shipping fixture')
    @Endpoint(POST, '/batch', WRITE, RPC, { background: true })
    sendBatch(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    /** An ordinary route on the same contract — the control for every assertion below. */
    @WpAuthPublic('Ordinary route fixture')
    @Endpoint(POST, '/ping', READ, RPC)
    ping(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@Endpoint background option', () => {
    it('round-trips in the parallel endpoint-options metadata, and is absent when undeclared', () => {
        expect(getEndpointOptions(SampleDevLogApi, 'sendBatch')).toEqual({
            background: true,
        });
        expect(getEndpointOptions(SampleDevLogApi, 'ping')).toEqual({});
    });

    it('rides RouteMetadata.background, exactly as formPost and rawBody do', () => {
        const shipper = RouteMetadataFactory.create(SampleDevLogApi, 'sendBatch');
        const ordinary = RouteMetadataFactory.create(SampleDevLogApi, 'ping');

        expect(shipper.background).toBe(true);
        expect(ordinary.background).toBe(false);
        // The neighbouring route flags are untouched by it — one declaration, one meaning.
        expect(shipper.formPost).toBe(false);
        expect(shipper.rawBody).toBe(false);
        expect(shipper.path).toBe('/api/web/devlog/batch');
    });
});
