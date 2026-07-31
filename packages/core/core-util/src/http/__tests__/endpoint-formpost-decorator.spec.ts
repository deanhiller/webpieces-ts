import 'reflect-metadata';
import {
    ApiPath,
    Endpoint,
    Public,
    getEndpoints,
    getEndpointOptions,
    isFormPost,
} from '../decorators';

@Public()
@ApiPath('/webhook')
abstract class SampleWebhookApi {
    // Default: JSON.
    @Endpoint('/rpc', 'rpc')
    rpc(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    // Explicit form-urlencoded (e.g. Twilio inbound) — driven by a system outside this repo, which
    // an `external` endpoint must now NAME (calledBy is required by the @Endpoint overloads).
    @Endpoint('/hook', 'external', { formPost: true, calledBy: 'twilio' })
    inbound(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@Endpoint formPost option', () => {
    it('keeps the ENDPOINTS path map unchanged (back-compat)', () => {
        expect(getEndpoints(SampleWebhookApi)).toEqual({
            rpc: '/rpc',
            inbound: '/hook',
        });
    });

    it('round-trips endpoint options in the parallel metadata map', () => {
        expect(getEndpointOptions(SampleWebhookApi, 'inbound')).toEqual({ formPost: true, calledBy: 'twilio' });
        // A method declared with no options resolves to an empty object, never undefined.
        expect(getEndpointOptions(SampleWebhookApi, 'rpc')).toEqual({});
    });

    it('isFormPost is true only for the annotated method, false by default', () => {
        expect(isFormPost(SampleWebhookApi, 'inbound')).toBe(true);
        expect(isFormPost(SampleWebhookApi, 'rpc')).toBe(false);
        // Unknown method → false (no options recorded).
        expect(isFormPost(SampleWebhookApi, 'nope')).toBe(false);
    });
});
